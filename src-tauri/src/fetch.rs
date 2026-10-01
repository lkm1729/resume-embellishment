//! 网页抓取（方块 5）。
//!
//! ⚠ 抓回来的文字是**不可信输入**，可能夹带提示注入。
//! 渲染侧的 `verifyNoInjection` 兜住它 —— 注入最多影响版式，改不了事实。
//! 这里额外尽一份本分：剥掉 `script` / `style`，不把可执行内容
//! 当成"正文"喂给模型。

use std::time::Duration;

use regex::Regex;
use serde::Serialize;

use crate::error::{CommandError, Result};

/// 一次抓取最多读这么多字节，防止一个巨大的页面把内存吃光。
const MAX_BYTES: usize = 2 * 1024 * 1024;
/// `Content-Length` 超过这个数就直接拒绝 —— 读都不读。
const REFUSE_ABOVE: u64 = 16 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(25);
/// 连上服务器的时间上限。总超时管不到「DNS 卡住 / 端口被丢包」这种情形 ——
/// 那种情况下 25 秒总超时意味着用户要盯着转圈整整 25 秒。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
/// 找 `;` 时向前看的**字符**数（不是字节数 —— 一个汉字占 3 字节）。
const WINDOW_CHARS: usize = 12;
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/// 抓取到的网页内容。与前端 `FetchedPage` 一一对应。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedPage {
    pub url: String,
    pub title: String,
    pub text: String,
    /// 实际读到的字节数（截断前）。
    pub bytes: usize,
    /// 是否因为超过上限而截断。
    pub truncated: bool,
}

/// 把一块响应数据追加进 `body`，最多追加到 `cap` 字节。
///
/// 返回 `true` 表示**已经攒满**，调用方应当停止读取。
///
/// 单独抽出来是为了能单测：这里是「一个超大页面会不会吃满内存」的唯一开关，
/// 而它恰恰是循环里最容易写错一格的地方（少读一个字节就永远发现不了截断，
/// 多读一个字节就让上限名存实亡）。
fn append_capped(body: &mut Vec<u8>, chunk: &[u8], cap: usize) -> bool {
    let room = cap.saturating_sub(body.len());
    if room == 0 {
        return true;
    }
    // 单个分块可能比剩余额度大，只取需要的部分 —— 多出来的字节由调用方
    // 通过「返回 true」直接放弃，不会再往下读。
    body.extend_from_slice(&chunk[..chunk.len().min(room)]);
    body.len() >= cap
}

/// 抓一个网页并抽出正文。
pub async fn fetch(url: &str) -> Result<FetchedPage> {
    // 只放 http/https 过去。
    // 少了这一步，「粘贴一个链接」就等于任意本地文件读取（file://）
    // 或对内网服务发起请求（http://192.168.x.x）—— 这是个真实的安全边界。
    let parsed = reqwest::Url::parse(url)
        .map_err(|e| CommandError::invalid(format!("这个链接看不懂：{e}")))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(CommandError::invalid(format!(
                "只支持 http / https 链接，收到的是 {other}:。"
            )))
        }
    }

    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        // 单独的连接超时：站点解析不到 / 端口不通时不该让用户干等 25 秒。
        // `timeout` 管的是**整个**请求，一个连不上的域名会一直磨到它为止。
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(UA)
        .build()
        .map_err(|e| CommandError::io(format!("创建 HTTP 客户端失败：{e}")))?;

    let mut resp = client
        .get(parsed.clone())
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        )
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|e| {
            let hint = if e.is_timeout() {
                "\n（超时了，页面可能太大或站点很慢。）"
            } else if e.is_connect() {
                "\n（连不上，检查网址和网络。）"
            } else {
                ""
            };
            CommandError::io(format!("打开 {url} 失败：{e}{hint}"))
        })?;

    let status = resp.status();
    if !status.is_success() {
        let hint = match status.as_u16() {
            404 => "（页面不存在。）",
            403 => "（站点拒绝了这次抓取。）",
            _ => "",
        };
        return Err(CommandError::io(format!(
            "打开 {url} 失败：HTTP {}{hint}",
            status.as_u16()
        )));
    }

    if let Some(len) = resp.content_length() {
        if len > REFUSE_ABOVE {
            return Err(CommandError::invalid(format!(
                "这个页面有 {:.1} MB，太大了，不抓。",
                len as f64 / 1024.0 / 1024.0
            )));
        }
    }

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    // 边读边攒，攒够就停 —— 不要 `resp.bytes().await`。
    //
    // `bytes()` 会把**整个响应体**读进内存之后我们才去截断，
    // 而上面那道 `REFUSE_ABOVE` 闸门只看得见 `content_length()`：
    //   · 分块传输（Transfer-Encoding: chunked）**根本没有**这个头；
    //   · gzip / brotli 时它报的是**压缩后**的大小，解压后可能大几十倍。
    // 两种情况都能让一个几百 MB 的页面先吃满内存、再让用户干等满 25 秒。
    // 配额多一个字节，是为了能如实判断「到底截断没有」。
    let mut body: Vec<u8> = Vec::new();
    let cap = MAX_BYTES + 1;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| CommandError::io(format!("读取 {url} 的内容失败：{e}")))?
    {
        if append_capped(&mut body, &chunk, cap) {
            break;
        }
    }
    // 这里 body.len() 是「我们实际收下的字节数」，最多 MAX_BYTES + 1。
    let total = body.len();
    let truncated = total > MAX_BYTES;
    let slice = &body[..total.min(MAX_BYTES)];
    // 页面编码未必是 UTF-8。有损转换至少不会报错，而绝大多数站点就是 UTF-8。
    let raw = String::from_utf8_lossy(slice).into_owned();

    let (title, text) = if content_type.contains("html") || looks_like_html(&raw) {
        (extract_title(&raw), html_to_text(&raw))
    } else {
        (String::new(), collapse(&raw))
    };

    Ok(FetchedPage {
        url: url.to_string(),
        title,
        text,
        bytes: total,
        truncated,
    })
}

fn looks_like_html(s: &str) -> bool {
    let head: String = s.chars().take(2000).collect::<String>().to_ascii_lowercase();
    head.contains("<!doctype html") || head.contains("<html")
}

fn re_title() -> &'static Regex {
    static R: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title\s*>").unwrap())
}

/// 取 `<title>` 的内容，顺便把标签与实体清掉。
pub fn extract_title(html: &str) -> String {
    let Some(caps) = re_title().captures(html) else {
        return String::new();
    };
    let raw = caps.get(1).map(|m| m.as_str()).unwrap_or("");
    collapse(&decode_entities(&strip_tags(raw)))
}

fn re_comment() -> &'static Regex {
    static R: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?s)<!--.*?-->").unwrap())
}

fn re_break() -> &'static Regex {
    static R: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)<(?:br|hr)\s*/?>|</(?:p|div|li|tr|h[1-6]|section|article|blockquote|td|th|table|ul|ol|pre|header|footer|main|nav|aside|figure)\s*>",
        )
        .unwrap()
    })
}

fn re_tag() -> &'static Regex {
    static R: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?s)<[^>]*>").unwrap())
}

fn strip_tags(html: &str) -> String {
    re_comment().replace_all(html, " ").into_owned()
}

/// HTML → 纯文本。
///
/// 不引 readability 那类库：简历与求职信只需要"能读的文字"，
/// 而这类页面的正文通常就在 `body` 里，剥掉标签就够。
pub fn html_to_text(html: &str) -> String {
    let body = drop_blocks(html);
    let without_comments = re_comment().replace_all(&body, " ");
    let with_breaks = re_break().replace_all(&without_comments, "\n");
    let bare = re_tag().replace_all(&with_breaks, "");
    collapse(&decode_entities(&bare))
}

/// 整块丢掉 `script` / `style` / `svg` 等元素，**连同标签内的内容**。
///
/// 为什么不用一条正则：Rust 的 `regex` crate 不支持反向引用，
/// 没法写「`<script>` 配 `</script>`」。手写扫描虽然啰嗦，
/// 但边界条件是清楚的（标签名后必须是空白 / `>` / `/`，
/// 所以 `<scripted>` 不会被误伤）。
fn drop_blocks(html: &str) -> String {
    const TAGS: [&str; 6] = ["script", "style", "noscript", "svg", "iframe", "template"];

    // `to_ascii_lowercase` 只映射 ASCII，字节长度与下标完全一致，
    // 所以可以在小写副本上找位置、再去原文切片。
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut copied = 0usize;
    let mut cursor = 0usize;

    while cursor < lower.len() {
        let Some(rel) = lower[cursor..].find('<') else { break };
        let lt = cursor + rel;

        let mut hit: Option<&str> = None;
        for tag in TAGS {
            let open = format!("<{tag}");
            if lower[lt..].starts_with(&open) {
                let after = lt + open.len();
                let boundary = matches!(
                    lower.as_bytes().get(after),
                    Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') | Some(b'>') | Some(b'/')
                );
                if boundary {
                    hit = Some(tag);
                    break;
                }
            }
        }

        match hit {
            None => cursor = lt + 1,
            Some(tag) => {
                let close = format!("</{tag}");
                let Some(rel_close) = lower[lt..].find(&close) else {
                    // 没闭合（页面被截断）：从这里一直丢到结尾。
                    // 光 break 不够 —— 循环出口还会把 `copied..` 的尾巴贴回去，
                    // 那正好把整段脚本源码当成「正文」喂给模型。
                    out.push_str(&html[copied..lt]);
                    out.push('\n');
                    copied = html.len();
                    break;
                };
                let after_close = lt + rel_close + close.len();
                let end = lower[after_close..]
                    .find('>')
                    .map(|r| after_close + r + 1)
                    .unwrap_or(after_close);
                out.push_str(&html[copied..lt]);
                out.push('\n');
                copied = end;
                cursor = end;
            }
        }
    }
    out.push_str(&html[copied.min(html.len())..]);
    out
}

/// 解 HTML 实体。只认常见的那些 —— 认错了比不认更糟。
pub fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;

    while let Some(idx) = rest.find('&') {
        out.push_str(&rest[..idx]);
        let tail = &rest[idx..];
        // 实体名不会太长；窗口开 12 个字符足够，也避免在超长文本里反复扫描。
        //
        // ⚠ 必须按**字符**边界切，不能按字节。`&` 后面紧跟中文时（`&此…`），
        // 字节 12 很可能正落在某个多字节字符内部，`&tail[..12]` 会 panic：
        //
        //     end byte index 12 is not a char boundary; it is inside '此'
        //
        // 这个 panic 不是「抓取失败」，它会把整个应用带走（见 logging.rs 的
        // panic hook）。所以这里是 `char_indices` 而不是 `len().min(12)`。
        let window = match tail.char_indices().nth(WINDOW_CHARS) {
            Some((end, _)) => &tail[..end],
            None => tail,
        };
        match window.find(';') {
            Some(end) => {
                let name = &tail[1..end];
                match named_entity(name).or_else(|| numeric_entity(name)) {
                    Some(ch) => {
                        out.push(ch);
                        rest = &tail[end + 1..];
                    }
                    None => {
                        out.push('&');
                        rest = &tail[1..];
                    }
                }
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn named_entity(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" | "ensp" | "emsp" | "thinsp" => ' ',
        "mdash" => '—',
        "ndash" => '–',
        "hellip" => '…',
        "ldquo" => '“',
        "rdquo" => '”',
        "lsquo" => '‘',
        "rsquo" => '’',
        "middot" => '·',
        "bull" => '•',
        "copy" => '©',
        "reg" => '®',
        "trade" => '™',
        "times" => '×',
        "divide" => '÷',
        "deg" => '°',
        "sect" => '§',
        "para" => '¶',
        "laquo" => '«',
        "raquo" => '»',
        "euro" => '€',
        "pound" => '£',
        "yen" => '¥',
        "cent" => '¢',
        "permil" => '‰',
        "prime" => '′',
        "Prime" => '″',
        "plusmn" => '±',
        "micro" => 'µ',
        "frac12" => '½',
        "larr" => '←',
        "rarr" => '→',
        "uarr" => '↑',
        "darr" => '↓',
        _ => return None,
    })
}

fn numeric_entity(name: &str) -> Option<char> {
    let digits = name.strip_prefix('#')?;
    let code = match digits.strip_prefix(['x', 'X']) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => digits.parse::<u32>().ok()?,
    };
    // 代理区不是合法码点，`from_u32` 会替我们否掉。
    char::from_u32(code)
}

/// 折叠空白：行内多空格合一、行首尾去掉、连续空行只留一个。
///
/// PDF 与 DOCX 里换行是**段落语义**，所以这里不能把所有换行拉平 ——
/// 那会把一整页简历压成一大段。
pub fn collapse(text: &str) -> String {
    let mut lines: Vec<String> = Vec::with_capacity(text.lines().count());

    for raw in text.lines() {
        let mut line = String::new();
        let mut trailing_space = false;
        for ch in raw.chars() {
            // U+00A0 是不换行空格，U+3000 是表意空格 —— 它们都是"空白"，
            // 但不等于 ASCII 空格，不归一化会在版式里变成奇怪的空档。
            if ch == ' ' || ch == '\t' || ch == '\u{a0}' || ch == '\u{3000}' {
                if !line.is_empty() {
                    trailing_space = true;
                }
            } else {
                if trailing_space {
                    line.push(' ');
                    trailing_space = false;
                }
                line.push(ch);
            }
        }
        if line.is_empty() {
            // 最多保留一个空行。
            if lines.last().map(|l| !l.is_empty()).unwrap_or(false) {
                lines.push(String::new());
            }
        } else {
            lines.push(line);
        }
    }

    while lines.last().map(String::is_empty).unwrap_or(false) {
        lines.pop();
    }
    lines.join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_and_styles_are_dropped_entirely() {
        let html = "<p>保留</p><script>var x = 1; <b>不要</b></script><style>.a{color:red}</style><p>也保留</p>";
        let text = html_to_text(html);
        assert!(text.contains("保留"));
        assert!(text.contains("也保留"));
        assert!(!text.contains("var x"));
        assert!(!text.contains("color:red"));
        assert!(!text.contains("不要"));
    }

    #[test]
    fn a_tag_name_prefix_is_not_mistaken_for_the_tag() {
        // `<scripted-source>` 不是 `<script>`。
        let html = "<scripted-source>正文</scripted-source>";
        let text = html_to_text(html);
        assert!(text.contains("正文"), "got {text:?}");
    }

    #[test]
    fn an_unclosed_script_does_not_leak_code() {
        let html = "<p>前</p><script>var leak = 1;";
        let text = html_to_text(html);
        assert!(text.contains("前"));
        assert!(!text.contains("leak"));
    }

    #[test]
    fn block_tags_become_newlines_and_inline_tags_do_not() {
        let html = "<div>第一行</div><div>第二行</div><p>第三行<b>加粗</b></p>";
        let text = html_to_text(html);
        assert_eq!(text, "第一行\n第二行\n第三行加粗");
    }

    #[test]
    fn br_becomes_a_newline() {
        let text = html_to_text("a<br>b<br/>c");
        assert_eq!(text, "a\nb\nc");
    }

    #[test]
    fn entities_are_decoded() {
        assert_eq!(html_to_text("a&nbsp;b&amp;c"), "a b&c");
        assert_eq!(decode_entities("&lt;tag&gt;"), "<tag>");
        assert_eq!(decode_entities("&#65;&#x42;"), "AB");
        // 不认识的原样保留，不要吃掉用户的内容。
        assert_eq!(decode_entities("&notarealentity;"), "&notarealentity;");
        assert_eq!(decode_entities("a & b"), "a & b");
    }

    #[test]
    fn a_bare_ampersand_followed_by_cjk_does_not_panic() {
        // 回归测试：窗口曾经按**字节**切成 12，`&` 后面紧跟中文时，
        // 第 12 个字节落在汉字内部 → `end byte index 12 is not a char boundary;
        // it is inside '此'`。这个 panic 会把整个应用带走，不只是这次抓取失败。
        assert_eq!(decode_entities("&此外"), "&此外");
        assert_eq!(decode_entities("&阿里巴巴"), "&阿里巴巴");
        // 没有 `;` 时窗口是空的，也必须安全。
        assert_eq!(decode_entities("&"), "&");
        assert_eq!(decode_entities("&中"), "&中");
        // 长汉字串跨过旧窗口边界。
        assert_eq!(
            decode_entities("&中华人民共和国万岁万岁万万岁"),
            "&中华人民共和国万岁万岁万万岁"
        );
        // 有 `;` 但名字不认识的，原样吐出。
        assert_eq!(decode_entities("&中文;"), "&中文;");
        // 真正的实体在中文语境里仍然要解出来。
        assert_eq!(decode_entities("A&amp;B 与 C&lt;D"), "A&B 与 C<D");
        assert_eq!(decode_entities("&nbsp;中文&nbsp;"), " 中文 ");
    }

    #[test]
    fn a_capped_append_stops_exactly_at_the_cap() {
        // 正常情况：没满就继续攒。
        let mut body = Vec::new();
        assert!(!append_capped(&mut body, b"abc", 10));
        assert_eq!(body, b"abc");
        assert!(!append_capped(&mut body, b"de", 10));
        assert_eq!(body, b"abcde");

        // 一块比剩余额度大：只收下够的那部分，并报告「满了」。
        assert!(append_capped(&mut body, b"fghijklmnop", 10));
        assert_eq!(body.len(), 10);
        assert_eq!(body, b"abcdefghij");

        // 满了之后再喂也不会涨 —— 上限是真的上限。
        assert!(append_capped(&mut body, b"zzz", 10));
        assert_eq!(body.len(), 10);

        // 恰好填满的那一次也要报告「满了」，否则调用方会白白多读一轮。
        let mut exact = Vec::new();
        assert!(append_capped(&mut exact, b"12345", 5));
        assert_eq!(exact, b"12345");

        // 空块不该把已经满的状态说成没满（否则就是死循环）。
        assert!(append_capped(&mut body, b"", 10));
    }

    #[test]
    fn title_is_extracted_and_cleaned() {
        assert_eq!(
            extract_title("<html><head><TITLE> 我的 简历 </TITLE></head></html>"),
            "我的 简历"
        );
        assert_eq!(extract_title("<html></html>"), "");
    }

    #[test]
    fn collapse_keeps_paragraph_breaks_but_kills_runs_of_blank_lines() {
        // 一串空行压成一个空行，行内的连续空格压成一个。
        assert_eq!(collapse("a\n\n\n\nb   c"), "a\n\nb c");
        // 只由空白组成的一行同样是空行，不该被当成正文。
        assert_eq!(collapse("a\n \t \nb"), "a\n\nb");
        // 单个换行是软换行，原样保留 —— 拉平会把整页简历压成一段。
        assert_eq!(collapse("a\nb"), "a\nb");
        // 结尾的空行全部去掉。
        assert_eq!(collapse("a\n\n\n"), "a");
    }

    #[test]
    fn collapse_normalizes_ideographic_and_nbsp_spaces() {
        assert_eq!(collapse("a\u{3000}\u{3000}b"), "a b");
        assert_eq!(collapse("a\u{a0}b"), "a b");
    }

    #[test]
    fn collapse_trims_the_ends() {
        assert_eq!(collapse("\n\n  内容  \n\n"), "内容");
    }

    #[test]
    fn plain_text_is_returned_as_is() {
        // 非 HTML 响应（比如 .txt）不该被当成 markup 处理。
        assert!(looks_like_html("just some text") == false);
        assert!(looks_like_html("<!DOCTYPE html><html>") == true);
        assert!(looks_like_html("  <HTML lang=\"zh\">") == true);
    }

    #[test]
    fn fetched_page_serializes_as_camel_case() {
        let page = FetchedPage {
            url: "https://example.com".to_string(),
            title: "标题".to_string(),
            text: "正文".to_string(),
            bytes: 12,
            truncated: false,
        };
        let json = serde_json::to_value(&page).unwrap();
        assert_eq!(json["url"], "https://example.com");
        assert_eq!(json["bytes"], 12);
        assert_eq!(json["truncated"], false);
        assert!(json.get("title").is_some());
    }
}
