//! 把生成好的文档同步到 Google Docs。
//!
//! # 为什么这条路上一定有 OAuth
//!
//! Google 没有提供任何「不带 OAuth 就能收下本地文件」的地址。
//! Drive API 概览的原话是：*OAuth 2.0 is the authorization protocol that the
//! Drive API requires to authenticate your app users*。所以第一步永远是
//! 让用户在自己的浏览器里登录并授权 —— 这不是我们偷懒，是没有别的门。
//!
//! # 凭据从哪来
//!
//! 程序不能凭空给自己发通行证：Client ID 必须由一个 Google Cloud 项目
//! 签发一次，而这一步只有用户本人能做。所以它被压缩成「三个直达链接 +
//! 一次粘贴」，并且**只做一次** —— refresh token 存在系统密钥环里，
//! 之后再点就是完整的「弹出浏览器 → 授权 → 上传 → 打开文档」。
//!
//! `client_secret` 也一起存进密钥环。Google 对桌面客户端类型本来就声明
//! 它不算机密（客户端类型选「桌面应用」时它随安装包分发），
//! 但放进凭据管理器比写进配置文件干净。
//!
//! # 权限只要 drive.file
//!
//! `drive.file` 是 Google 分类里的**非敏感**权限，只能看到「本应用创建的、
//! 或用户主动交给本应用的文件」，读不到用户 Drive 里的其他任何东西。
//! 非敏感权限不需要 Google 审核，用户自己就能发布这个应用。
//! 隐私上也更让人放心：就算这里写错了，也翻不到用户的别的文件。
//!
//! # 回环重定向仍然是官方支持的桌面流程
//!
//! `http://127.0.0.1:<任意端口>` 正是 Desktop app 客户端类型的标准重定向。
//! Google 的迁移指南写得很明确：loopback 流程对 iOS / Android / Chrome app
//! 客户端已经废弃，但对桌面应用 *"will continue to be supported on desktop apps"*。
//! 端口每次随机，所以同时开两份程序也不会抢端口。
//!
//! # 上传的是 .docx，拿到的是 Google 文档
//!
//! 元数据里把 `mimeType` 写成 `application/vnd.google-apps.document`，
//! 媒体体仍然是 .docx 字节 —— 这等于让 Google 用它自己的 Word 导入器
//! 转一次。这比我们自己拼一份 Google 文档 JSON 靠谱得多，
//! 也是这条通路比「复制成 HTML 再粘贴」保真度更高的原因。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::{CommandError, Result};
use crate::secrets;

/// 密钥环里的条目名。整份凭据（含两个客户端字段与 refresh token）
/// 序列化成一段 JSON 存在这一个条目里 —— 三样东西要么一起有效，
/// 要么一起失效，拆成三条只会多出「装了一半」的状态。
const SECRET_REF: &str = "google:oauth";

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const UPLOAD_ENDPOINT: &str = "https://www.googleapis.com/upload/drive/v3/files";

/// 只申请这一个权限。换 `drive` 会变成**受限**权限，
/// 那需要 Google 官方审核 —— 对一个自用工具来说完全不可行。
const DRIVE_FILE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

const DOCX_MIME: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const GOOGLE_DOC_MIME: &str = "application/vnd.google-apps.document";

/// 等用户在浏览器里登录并授权的上限。
/// 五分钟：够他输密码、过两步验证、再读一遍权限说明；
/// 又短到中途放弃的人不必等一个永远不会来的回调。
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

/// 轮询回环端口的间隔。这个函数每 120ms 醒一次，
/// 而用户从点授权到浏览器跳回来至少也要几秒，所以完全够用。
const POLL_INTERVAL: Duration = Duration::from_millis(120);

// ─────────────────────── 数据结构 ───────────────────────

/// 存进密钥环的那一份。字段名用 camelCase，因为它是我们自己序列化的 JSON。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCredentials {
    pub client_id: String,
    pub client_secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
}

/// 给前端看的连接状态。**刻意不含任何密钥字段** ——
/// 这份结构会一路进前端状态、进 React DevTools、进用户截图，
/// 往里放 secret 迟早会漏。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleStatus {
    /// 填过 Client ID 与 Client Secret。
    pub configured: bool,
    /// 拿到过 refresh token。
    pub connected: bool,
    /// 回填输入框用。Client ID 本来就是公开信息。
    pub client_id: String,
}

/// 上传成功的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleDoc {
    pub id: String,
    pub name: String,
    /// 浏览器里打开这个文档的地址。
    pub url: String,
}

impl GoogleStatus {
    fn of(creds: Option<&GoogleCredentials>) -> Self {
        Self {
            configured: creds.is_some_and(|c| {
                !c.client_id.trim().is_empty() && !c.client_secret.trim().is_empty()
            }),
            connected: creds.is_some_and(|c| c.refresh_token.is_some()),
            client_id: creds.map(|c| c.client_id.clone()).unwrap_or_default(),
        }
    }
}

// ─────────────────────── 凭据存取 ───────────────────────

fn load_credentials() -> Result<Option<GoogleCredentials>> {
    match secrets::load(SECRET_REF)? {
        None => Ok(None),
        Some(raw) => serde_json::from_str(&raw).map(Some).map_err(|e| {
            // 不静默重置：用户重新填一次就能覆盖，但那要他知情。
            CommandError::corrupt_config(format!(
                "密钥环里保存的 Google 凭据读不出来：{e}\n\
                 在「同步到 Google Docs」的设置里重新填写一次即可覆盖它。"
            ))
        }),
    }
}

fn save_credentials(creds: &GoogleCredentials) -> Result<()> {
    let raw = serde_json::to_string(creds)
        .map_err(|e| CommandError::io(format!("序列化 Google 凭据失败：{e}")))?;
    secrets::store(SECRET_REF, &raw)
}

/// 保存用户粘贴的 Client ID / Client Secret。
///
/// **一定会清掉旧的 refresh token**：换了客户端等于换了身份，
/// 旧凭据在新的 Client ID 下必然被拒。留着它只会让下一次上传
/// 报一个 `invalid_client`，而用户完全不知道那口锅是上一次授权背的。
pub fn save_client(client_id: &str, client_secret: &str) -> Result<GoogleStatus> {
    let client_id = client_id.trim();
    let client_secret = client_secret.trim();

    if client_id.is_empty() || client_secret.is_empty() {
        return Err(CommandError::invalid(
            "Client ID 与 Client Secret 都要填。\n\
             两个都在 Google Cloud 的「凭据」页面里，复制时不要带多余的空格。",
        ));
    }
    if !client_id.ends_with(".apps.googleusercontent.com") {
        // 回显要短。用户粘进来的很可能根本不是 Client ID —— 可能是
        // 项目编号、一整行控制台文字、或者别的什么东西，原样倒回去
        // 既没帮助又难看。
        return Err(CommandError::invalid(format!(
            "这个 Client ID 看起来不对：\n{}\n\n\
             正确的形如 1234567890-abcdefg.apps.googleusercontent.com。\n\
             常见的错法是复制成了「项目编号」「API 密钥」，或者 OAuth 客户端的类型选成了别的。",
            clip(client_id)
        )));
    }

    let creds = GoogleCredentials {
        client_id: client_id.to_string(),
        client_secret: client_secret.to_string(),
        refresh_token: None,
    };
    save_credentials(&creds)?;
    Ok(GoogleStatus::of(Some(&creds)))
}

/// 断开连接：只清 refresh token，保留两个客户端字段。
///
/// 用户多半只是想换一个 Google 账号。为了这个让他再跑一趟 Cloud Console
/// 就太不讲道理了。
pub fn disconnect() -> Result<GoogleStatus> {
    match load_credentials()? {
        None => Ok(GoogleStatus::of(None)),
        Some(mut creds) => {
            creds.refresh_token = None;
            save_credentials(&creds)?;
            Ok(GoogleStatus::of(Some(&creds)))
        }
    }
}

// ─────────────────────── PKCE 与随机数 ───────────────────────

/// 32 字节密码学随机数，写成 base64url。
/// PKCE 的 verifier 与防 CSRF 的 state 都用它。
fn random_token() -> Result<String> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf)
        .map_err(|e| CommandError::new("google", format!("取系统随机数失败：{e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

/// PKCE 的 S256 挑战：`base64url(sha256(verifier))`。
fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// 把 `%XX` 还原。授权码里 `/` 经常以 `%2F` 出现，不还原就会拿一个坏码去换 token。
///
/// `+` 刻意**不**当成空格：那是 form-urlencoded 的规矩，而 Google 的授权码
/// 是 URL-safe base64（用 `-` 和 `_`），永远不会出现真正的 `+`。
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 从 HTTP 请求行里取一个查询参数。
///
/// 注意内层用 `let ... else { continue }` 而不是 `?` —— 用 `?` 的话，
/// 遇到第一个没有 `=` 的片段（`?a&code=x`）就会整条放弃，
/// 把真正要找的参数一起丢掉。
fn query_value(request_line: &str, key: &str) -> Option<String> {
    let target = request_line.split_whitespace().nth(1)?;
    let query = target.split_once('?')?.1;
    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        if k == key {
            return Some(percent_decode(v));
        }
    }
    None
}

/// 从回环回调里取出授权码；`state` 对不上就拒绝。
///
/// 返 `Ok(None)` 表示这一趟不是回调（浏览器还会顺手来要 favicon），
/// 继续等下一趟。
///
/// 抽成纯函数是为了能测。非要开一个真 socket 才能测的话，
/// 这段逻辑多半就没人测了 —— 而它恰好是最该测的一段。
fn parse_callback(request_line: &str, expected_state: &str) -> Result<Option<String>> {
    if let Some(err) = query_value(request_line, "error") {
        return Err(CommandError::new(
            "google_denied",
            format!(
                "Google 没有批准这次授权：{err}\n\
                 如果显示 access_denied，通常是授权页上点了「取消」；\
                 如果显示 org_internal，是这个 Cloud 项目限制成了组织内部使用。"
            ),
        ));
    }

    let Some(code) = query_value(request_line, "code") else {
        return Ok(None);
    };

    match query_value(request_line, "state") {
        Some(state) if state == expected_state => Ok(Some(code)),
        // 对不上说明这一趟不是我们发起的那次授权（本机别的进程也能往这个端口发东西）。
        // 拿它去换 token 等于把用户的授权交给别人，所以宁可整趟作废。
        _ => Err(CommandError::new(
            "google_state",
            "授权回调里的 state 与本次请求对不上，已忽略这次结果。\n\
             请重新点一次「连接 Google 账号」。",
        )),
    }
}

// ─────────────────────── 回环回调 ───────────────────────

/// 「取消等待」的旗子。
///
/// 用模块级的 `AtomicBool` 而不是 Tauri 的 managed state：等回调发生在
/// 一个 `spawn_blocking` 线程里，它拿不到 AppHandle，也不需要拿到 ——
/// 它只要知道用户还等不等。`google_cancel` 是另一个独立命令，所以在
/// `connect` 还挂着的时候照样能跑进来把它放倒。
static CANCEL: AtomicBool = AtomicBool::new(false);

/// 让正在等待的那次 `connect` 立刻收手。
pub fn cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// 读 HTTP 请求的第一行就够：授权码在请求行里，后面的头一个字都不用看。
fn read_request_line(stream: &mut TcpStream) -> Option<String> {
    let mut raw = Vec::with_capacity(2048);
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&chunk[..n]);
                // 有了换行就说明请求行到齐了；上限是防一个不闭合的连接把它撑爆。
                if raw.contains(&b'\n') || raw.len() > 16 * 1024 {
                    break;
                }
            }
            // 调用方把这个流设成了「阻塞 + 读超时」，所以正常情况不会
            // 走到这里。真走到了说明对方连了却不发东西，放弃这一条连接
            // 就好 —— 循环还会继续 accept，不影响后面真正的回调。
            Err(_) => break,
        }
    }
    let end = raw.iter().position(|b| *b == b'\n').unwrap_or(raw.len());
    let line: Vec<u8> = raw[..end].iter().copied().filter(|b| *b != b'\r').collect();
    String::from_utf8(line).ok()
}

/// 给浏览器回一个页面。用户在这一步已经授权完了，
/// 这个页面的唯一职责是告诉他「可以关掉这一页，回到应用里去」。
fn respond(stream: &mut TcpStream, heading: &str, detail: &str) {
    let html = format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\
         <title>{heading}</title></head>\
         <body style=\"margin:0;height:100vh;display:flex;align-items:center;\
         justify-content:center;background:#0f1115;color:#e6e8eb;\
         font-family:'Microsoft YaHei','Segoe UI',system-ui,sans-serif\">\
         <div style=\"max-width:34rem;padding:2rem;text-align:center\">\
         <h1 style=\"font-size:1.25rem;font-weight:600;margin:0 0 .75rem\">{heading}</h1>\
         <p style=\"margin:0;line-height:1.7;color:#9aa4b2;font-size:.9rem\">{detail}</p>\
         </div></body></html>"
    );
    let header = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        html.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(html.as_bytes());
    let _ = stream.flush();
}

/// 在回环地址上等 Google 把授权码送回来。
///
/// 用非阻塞 accept + 轮询，而不是一次阻塞 accept：超时之后线程要能自己退出来。
/// 否则用户每中途放弃一次，就永久留下一个卡在 accept 上的线程。
fn wait_for_code(listener: TcpListener, expected_state: &str) -> Result<String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| CommandError::new("google", format!("设置回环端口失败：{e}")))?;

    let deadline = Instant::now() + CALLBACK_TIMEOUT;
    loop {
        if CANCEL.load(Ordering::SeqCst) {
            return Err(CommandError::new(
                "google_cancelled",
                "已取消等待授权。想继续的话再点一次「连接 Google 账号」。",
            ));
        }
        if Instant::now() >= deadline {
            return Err(CommandError::new(
                "google_timeout",
                "等了五分钟也没等到浏览器里的授权结果。\n\
                 可能是授权页被关掉了，或者卡在了登录上。再点一次「连接 Google 账号」即可重新开始。",
            ));
        }

        match listener.accept() {
            Ok((mut stream, _)) => {
                // accept 出来的流会继承监听套接字的非阻塞模式（Windows 上
                // 就是这样）。若不在这里改回阻塞，第一行还没到齐时
                // `read` 会立刻返回 WouldBlock，请求行被读成空串 ——
                // 于是真正的授权回调被判成 favicon，用户只看到 404，
                // 而这边一直等到超时。读超时是兜底：对方连上却不发数据
                // 时不能把这一轮卡死。
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let line = read_request_line(&mut stream).unwrap_or_default();
                match parse_callback(&line, expected_state) {
                    Ok(Some(code)) => {
                        respond(
                            &mut stream,
                            "授权成功",
                            "已经连接上你的 Google 账号。回到「简历与求职信美化」里继续就行，这个页面可以关掉了。",
                        );
                        return Ok(code);
                    }
                    Ok(None) => {
                        // favicon 之类。回一个空 404 让它走开，继续等真正的回调。
                        let _ = stream.write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                        let _ = stream.flush();
                    }
                    Err(e) => {
                        respond(&mut stream, "授权没有完成", &e.message);
                        return Err(e);
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(e) => return Err(e.into()),
        }
    }
}

// ─────────────────────── 与 Google 说话 ───────────────────────

fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| CommandError::new("google", format!("创建 HTTP 客户端失败：{e}")))
}

/// 从 Google 的错误响应里挖出人话。
///
/// Google 把有用的信息放在 `error_description` 或 `error.message`。
/// 直接把 `resp.text()` 甩给用户的话，他看到的是一坨 JSON ——
/// 而这一层的错误十有八九是他自己粘贴错了东西，正需要看得懂。
fn describe_http_error(status: reqwest::StatusCode, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let detail = parsed.as_ref().and_then(|v| {
        v.get("error_description")
            .and_then(Value::as_str)
            .or_else(|| v.pointer("/error/message").and_then(Value::as_str))
            .or_else(|| v.get("error").and_then(Value::as_str))
    });
    match detail {
        Some(d) => format!("Google 返回 {status}：{}{}", clip(d), hint_for(d)),
        // 走到这里说明响应不是 Google 那个 JSON 形状 —— 多半是代理页、
        // 门户登录页或一坨 HTML。原样倒出去会在 11px 的小字里塞进整页
        // 标签，所以过一遍 `clip`：网页整段换成一句话，其余截断。
        None => format!("Google 返回 {status}：{}", clip(body)),
    }
}

/// 把一段来历不明的响应体压成能放进一小段界面文字的样子。
///
/// 触发条件是「服务器没按约定回 JSON」—— 那正是最可能出现 HTML
/// 或超长内容的时候，而这段文字会**原样显示给用户**（见
/// `toCommandError` 与 `GoogleDocsBar` 的错误段落）。截断既是为了
/// 版面，也是为了不让一整页别人家的 HTML 变成我们界面的内容。
fn clip(body: &str) -> String {
    let trimmed = body.trim();
    let looks_like_html = trimmed.starts_with('<') || trimmed.contains("</");
    let source = if looks_like_html { "（对方返回的是一个网页，不是错误信息）" } else { trimmed };
    let mut out: String = source.chars().take(400).collect();
    if source.chars().count() > 400 {
        out.push('…');
    }
    out
}

/// 给几个最常见的报错配一句「所以你现在该干什么」。
/// 这些字符串是 Google 的固定枚举值，不是给人读的句子，直接展示等于没说。
fn hint_for(detail: &str) -> &'static str {
    if detail.contains("invalid_client") {
        "\n\n（Client ID 或 Client Secret 不对。回 Google Cloud 的「凭据」页面重新复制一次，\
         注意别把 Client Secret 复制成 API 密钥。）"
    } else if detail.contains("redirect_uri_mismatch") {
        "\n\n（这个 OAuth 客户端的类型不对，必须是「桌面应用 / Desktop app」。\
         Web 应用类型会要求预先登记回调地址，本工具用的是随机端口。）"
    } else if detail.contains("invalid_grant") {
        "\n\n（这次授权已经用过或者被撤销了。重新点一次「连接 Google 账号」即可。）"
    } else if detail.contains("insufficient") || detail.contains("SCOPE_INSUFFICIENT") {
        "\n\n（授权范围不够。请断开后重新连接一次，在授权页上勾选云端硬盘权限。）"
    } else if detail.contains("access_denied") {
        "\n\n（授权页上点了拒绝。重新连接一次并在权限页选择「继续」。）"
    } else {
        ""
    }
}

fn build_auth_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> Result<String> {
    let mut url = reqwest::Url::parse(AUTH_ENDPOINT)
        .map_err(|e| CommandError::new("google", format!("授权地址不合法：{e}")))?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", DRIVE_FILE_SCOPE)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        // 这两个参数一起决定「授权一次就够」：
        // 没有 access_type=offline 就没有 refresh token，下次还得再登一次；
        // 没有 prompt=consent，Google 在第二次授权时不会再发 refresh token。
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    Ok(url.into())
}

/// 把一串键值编成 `application/x-www-form-urlencoded` 的请求体。
///
/// 自己写而不是用 `RequestBuilder::form`：那个方法挂在 reqwest 的
/// `form` 特性后面，而它会把 `serde_urlencoded` 拉进依赖树 ——
/// 本机 registry 缓存里没有这个包，离线构建直接失败。
/// 编码规则本身很短，`percent-encoding` 又已经是现成的依赖。
///
/// 保留 `-` `.` `_` `~`（RFC 3986 的 unreserved）。多编码它们无害，
/// 但 client_secret 与授权码里 `-` `_` 很常见，少编码一截能让请求体短一些，
/// 出问题时肉眼看也清楚。
fn form_encode(pairs: &[(&str, &str)]) -> String {
    const UNRESERVED: &AsciiSet = &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'.')
        .remove(b'_')
        .remove(b'~');

    let mut out = String::new();
    for (key, value) in pairs {
        if !out.is_empty() {
            out.push('&');
        }
        out.push_str(&utf8_percent_encode(key, UNRESERVED).to_string());
        out.push('=');
        out.push_str(&utf8_percent_encode(value, UNRESERVED).to_string());
    }
    out
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

async fn post_token(form: &[(&str, &str)]) -> Result<TokenResponse> {
    let resp = http_client()?
        .post(TOKEN_ENDPOINT)
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(form_encode(form))
        .send()
        .await
        .map_err(|e| {
            CommandError::new(
                "google",
                format!("连不上 Google 的授权服务器：{e}\n请检查网络（这一步需要能访问 accounts.google.com）。"),
            )
        })?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(CommandError::new(
            "google_auth",
            describe_http_error(status, &body),
        ));
    }
    serde_json::from_str(&body).map_err(|e| {
        CommandError::new(
            "google",
            format!("Google 的授权响应读不出来：{e}\n原文：{}", body.trim()),
        )
    })
}

async fn exchange_code(
    creds: &GoogleCredentials,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<TokenResponse> {
    post_token(&[
        ("code", code),
        ("client_id", &creds.client_id),
        ("client_secret", &creds.client_secret),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
        ("code_verifier", verifier),
    ])
    .await
}

/// 用 refresh token 换一个短命的 access token。
///
/// 每次都换、不缓存：access token 一小时就过期，为它维护一套
/// 「还剩多久、要不要提前刷新」的状态，换来的只是省下一次往返，
/// 却多出「时钟不对就永远刷新失败」这一整类 bug。
async fn access_token(creds: &GoogleCredentials, refresh: &str) -> Result<String> {
    let tokens = post_token(&[
        ("client_id", &creds.client_id),
        ("client_secret", &creds.client_secret),
        ("refresh_token", refresh),
        ("grant_type", "refresh_token"),
    ])
    .await?;
    Ok(tokens.access_token)
}

// ─────────────────────── 上传 ───────────────────────

/// Drive 里的文件名。上传的是转换后的 Google 文档，所以 `.docx` 后缀
/// 留在名字里只会显得奇怪（而且用户会在 Drive 里看到「简历.docx」这个名字
/// 挂在一个 Google 文档图标上）。
fn drive_name(raw: &str) -> String {
    let trimmed = raw.trim();
    let stem = trimmed
        .strip_suffix(".docx")
        .or_else(|| trimmed.strip_suffix(".DOCX"))
        .unwrap_or(trimmed)
        .trim();
    if stem.is_empty() {
        "未命名文档".to_string()
    } else {
        stem.to_string()
    }
}

/// 拼 Drive 要的 `multipart/related` 请求体。
///
/// 手拼而不是用 reqwest 的 `.multipart()`：那个是给表单用的
/// `multipart/form-data`，Drive 不认这个形状 —— 它会当成一个普通字段，
/// 然后回一句「不支持的文件类型」。
///
/// 单独成一个纯函数是为了能被单测钉住。这段代码的失败模式是
/// 「Drive 回 400，而本地怎么试都复现不了」，所以它的价值全在
/// 那几个 CRLF 和结尾边界上，值得有测试。
fn multipart_body(boundary: &str, metadata: &str, bytes: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(bytes.len() + metadata.len() + 256);
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(metadata.as_bytes());
    body.extend_from_slice(
        format!("\r\n--{boundary}\r\nContent-Type: {DOCX_MIME}\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

async fn upload(
    token: &str,
    name: &str,
    bytes: &[u8],
) -> Result<GoogleDoc> {
    // 分段边界必须是「内容里不会出现」的字符串。32 字节随机数的 base64url
    // 撞上 .docx 字节序列的概率可以当成零。
    let boundary = format!("re{}", random_token()?);
    let metadata = json!({ "name": name, "mimeType": GOOGLE_DOC_MIME }).to_string();
    let body = multipart_body(&boundary, &metadata, bytes);

    let resp = http_client()?
        // 查询串直接拼进地址：`.query()` 与 `.form()` 在 reqwest 0.13 里
        // 同属 `form` 特性（见 form_encode 的注释）。
        // 两个值都是固定字面量，逗号在查询串里本就合法，不需要转义。
        .post(format!(
            "{UPLOAD_ENDPOINT}?uploadType=multipart&fields=id%2Cname%2CwebViewLink"
        ))
        .header("Authorization", format!("Bearer {token}"))
        .header(
            "Content-Type",
            format!("multipart/related; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|e| {
            CommandError::new(
                "google",
                format!("上传到 Google 云端硬盘失败：{e}\n请检查网络（这一步需要能访问 googleapis.com）。"),
            )
        })?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(CommandError::new(
            "google_upload",
            describe_http_error(status, &text),
        ));
    }

    let parsed: Value = serde_json::from_str(&text).map_err(|e| {
        CommandError::new(
            "google",
            format!("云端硬盘的响应读不出来：{e}\n原文：{}", clip(&text)),
        )
    })?;
    let id = parsed
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if id.is_empty() {
        return Err(CommandError::new(
            "google",
            format!("云端硬盘没有返回文档编号。原文：{}", clip(&text)),
        ));
    }

    Ok(GoogleDoc {
        // 文档编号必然在，而 webViewLink 理论上可能缺；缺了就自己拼一个 ——
        // Google 文档的编辑地址是稳定的，拼出来的和返回的一模一样。
        url: parsed
            .get("webViewLink")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("https://docs.google.com/document/d/{id}/edit")),
        name: parsed
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(name)
            .to_string(),
        id,
    })
}

// ─────────────────────── 对外接口 ───────────────────────
//
// 这里刻意**不加** `#[tauri::command]`：本项目的约定是「命令只有 lib.rs 有」，
// 业务模块一律导出普通函数由 lib.rs 包一层。好处是命令名与参数形状
// 集中在一个文件里看得完，也让这一层能被单测直接调用。

/// 当前的连接状态。前端靠它决定是显示「连接 Google 账号」还是「同步」。
pub fn status() -> Result<GoogleStatus> {
    Ok(GoogleStatus::of(load_credentials()?.as_ref()))
}

// 断开连接见上面的 `disconnect()` —— 它与 `save_client` 挨在一起，
// 因为两者都在动同一份凭据。

/// 走一遍完整的授权：开回环端口 → 打开默认浏览器 → 等回调 → 换长期凭据。
///
/// 这是一个 async 函数，但等待回调的那段是阻塞的 —— 所以它被挪进了
/// `spawn_blocking`。直接在 async 里阻塞会占住 tokio 的一个 worker 线程，
/// 而用户可能要在浏览器里待上好几分钟。
pub async fn connect() -> Result<GoogleStatus> {
    // 上一轮可能被取消过。旗子必须在这一次开始前放平，否则新的一开
    // 始就自杀。（同一时刻只会有一次 connect：界面上整个栏位在等待
    // 期间是按下不动的。）
    CANCEL.store(false, Ordering::SeqCst);

    let creds = load_credentials()?.ok_or_else(|| {
        CommandError::new(
            "google_not_configured",
            "还没有填写 Client ID 与 Client Secret。",
        )
    })?;

    // 端口交给系统挑：固定端口会在用户同时开着两份程序时失败，
    // 而 Desktop app 客户端类型本来就允许 127.0.0.1 上的任意端口。
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| {
        CommandError::new(
            "google",
            format!("在本机开一个临时端口失败：{e}\n可能是安全软件拦住了。"),
        )
    })?;
    let port = listener
        .local_addr()
        .map_err(|e| CommandError::new("google", format!("读不到刚申请的端口：{e}")))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let verifier = random_token()?;
    let state = random_token()?;
    let url = build_auth_url(
        &creds.client_id,
        &redirect_uri,
        &state,
        &code_challenge(&verifier),
    )?;

    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| {
        CommandError::new(
            "google",
            format!("打不开系统默认浏览器：{e}\n可以手动复制这个地址到浏览器里打开：\n{url}"),
        )
    })?;

    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(listener, &state))
        .await
        .map_err(|e| CommandError::new("google", format!("等待授权结果的任务异常结束：{e}")))??;

    // 换 token 这一步失败时，那个授权码已经用掉了（Google 的一次性码，
    // 而且 `wait_for_code` 已经把它从浏览器手里收走）。用户看到的若是
    // 一句干巴巴的 invalid_grant，他不会知道唯一出路是重来一遍。
    let tokens = exchange_code(&creds, &code, &redirect_uri, &verifier)
        .await
        .map_err(|e| {
            CommandError::new(
                e.kind,
                format!(
                    "{}\n这次拿到的授权码已经用掉了（它只能用一次），\
                     请再点一次「连接 Google 账号」从头走一遍。",
                    e.message
                ),
            )
        })?;
    let refresh = tokens.refresh_token.ok_or_else(|| {
        CommandError::new(
            "google",
            "Google 这次没有发长期凭据（refresh token）。\n\
             请到 Google 账号的「安全性 → 第三方应用」里移除本应用的授权，然后重新连接一次。",
        )
    })?;

    let next = GoogleCredentials {
        refresh_token: Some(refresh),
        ..creds
    };
    save_credentials(&next)?;
    Ok(GoogleStatus::of(Some(&next)))
}

/// 把 .docx 上传成一份 Google 文档，返回它的地址。
///
/// 字节由前端传进来（`buildDocx` 的产物），不落盘 ——
/// 用户要的是「同步到 Google Docs」，不是「先存一个文件再上传」。
///
/// 走 base64 字符串而不是 `Vec<u8>`：Tauri 的 IPC 会把字节数组展开成
/// 一个 JSON 数字数组，一份几十 KB 的 docx 会变成几十万个数字，
/// 消息体积和序列化开销都是荒唐的。前端 `btoa` 一次就够。
pub async fn upload_docx(name: String, docx_base64: String) -> Result<GoogleDoc> {
    let bytes = BASE64_STANDARD
        .decode(docx_base64.trim())
        .map_err(|_| CommandError::invalid("这份 Word 数据读不出来，可能传输时损坏了。"))?;
    if bytes.is_empty() {
        return Err(CommandError::invalid("要上传的内容是空的。"));
    }

    let creds = load_credentials()?.ok_or_else(|| {
        CommandError::new(
            "google_not_configured",
            "还没有填写 Client ID 与 Client Secret。",
        )
    })?;
    let refresh = creds.refresh_token.clone().ok_or_else(|| {
        CommandError::new(
            "google_not_connected",
            "还没有连接 Google 账号。先点「连接 Google 账号」，在浏览器里授权一次。",
        )
    })?;

    let token = access_token(&creds, &refresh).await?;
    upload(&token, &drive_name(&name), &bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_challenge_matches_the_rfc_7636_worked_example() {
        // RFC 7636 附录 B 的官方样例。这一条同时钉住两件事：
        // sha256 用对了，base64url 也**没有**带 padding —— 带了的话
        // Google 会以 invalid_grant 拒绝，而那个错看起来跟 PKCE 毫无关系。
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            code_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn random_tokens_differ_and_are_url_safe() {
        let a = random_token().unwrap();
        let b = random_token().unwrap();
        assert_ne!(a, b);
        assert!(a.len() >= 32);
        // 授权 URL 与 PKCE 都要求这些字符不带转义，出现 + / = 就会破坏查询串。
        assert!(!a.contains(['+', '/', '=']));
    }

    #[test]
    fn percent_decode_restores_slashes_and_leaves_plus_alone() {
        // 授权码里的 / 常以 %2F 出现，不还原就会拿一个坏码去换 token。
        assert_eq!(percent_decode("4%2F0Aabc"), "4/0Aabc");
        assert_eq!(percent_decode("a%2Bb"), "a%2Bb".replace("%2B", "+"));
        // 单独一个 + 不是空格：Google 的码是 URL-safe base64，不会产生它。
        assert_eq!(percent_decode("a+b"), "a+b");
        // 残缺的转义原样留着，不要 panic，也不要吃掉后面的字符。
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn form_encode_escapes_what_a_form_body_must_escape() {
        // 换 token 的请求体里有 redirect_uri 与 client_secret 两个
        // 含特殊字符的值。少编码一个 & 或 = 就会被 Google 当成多出来的参数，
        // 换回来一个 invalid_request，而报错完全指不到这里。
        let body = form_encode(&[
            ("grant_type", "authorization_code"),
            ("redirect_uri", "http://127.0.0.1:51234"),
            ("client_secret", "GOCSPX-a_b-c.d~e"),
        ]);
        assert_eq!(
            body,
            "grant_type=authorization_code\
             &redirect_uri=http%3A%2F%2F127.0.0.1%3A51234\
             &client_secret=GOCSPX-a_b-c.d~e"
        );

        // 保留 - . _ ~（RFC 3986 unreserved），其余一律转义。
        assert_eq!(form_encode(&[("a", "1 2+3/4")]), "a=1%202%2B3%2F4");
        // 空值也要留下 `key=`，不能整个键消失 —— Google 会当成参数没给。
        assert_eq!(form_encode(&[("fields", "")]), "fields=");
        // 空输入不能 panic。
        assert_eq!(form_encode(&[]), "");
    }

    #[test]
    fn multipart_body_has_the_exact_framing_drive_expects() {
        // 这一段是全项目最难在本地复现的代码：写错一个 CRLF，得到的
        // 是 Drive 的一句 400，而没有任何线索指向这里。所以逐字节钉住。
        let body = multipart_body("XY", r#"{"name":"a.docx"}"#, b"DOCX");
        assert_eq!(
            String::from_utf8(body).unwrap(),
            "--XY\r\n\
             Content-Type: application/json; charset=UTF-8\r\n\
             \r\n\
             {\"name\":\"a.docx\"}\r\n\
             --XY\r\n\
             Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\
             \r\n\
             DOCX\r\n\
             --XY--\r\n"
        );
    }

    #[test]
    fn multipart_body_keeps_binary_media_intact() {
        // 媒体段不能走任何字符串处理。这里塞进含 CRLF 与 0x00 的字节，
        // 要求它们一个不少地出现在两个边界之间。
        let payload: Vec<u8> = vec![0x00, b'\r', b'\n', 0xff, b'-', b'-'];
        let body = multipart_body("B", "{}", &payload);
        // ⚠ 不能直接找第一个 `\r\n\r\n` —— 那个是**元数据段**的分隔空行
        // （在 `{}` 之前）。必须先跳到媒体段的 Content-Type，再从它后面
        // 找空行，否则比对的其实是元数据。
        let media_head = body
            .windows(DOCX_MIME.len())
            .position(|w| w == DOCX_MIME.as_bytes())
            .expect("媒体段的 Content-Type");
        let start = media_head + DOCX_MIME.len() + b"\r\n\r\n".len();
        // 结尾边界写成 `--B--`：`\r\n--B` 在元数据段后面也出现一次，
        // 只有闭合边界带末尾那两个短横。
        let end = body
            .windows(b"\r\n--B--".len())
            .position(|w| w == b"\r\n--B--")
            .expect("结尾边界");
        assert_eq!(&body[start..end], &payload[..]);
    }

    #[test]
    fn the_metadata_part_survives_a_hostile_document_name() {
        // 简历文件名里出现引号和换行不是不可能（用户手打的）。json! 会
        // 转义，但这一点值得钉住：漏了就会拼出一段非法 JSON，Drive 回 400。
        let metadata = json!({ "name": "他说\"你好\"\n第二行.docx", "mimeType": GOOGLE_DOC_MIME })
            .to_string();
        let parsed: Value = serde_json::from_str(&metadata).unwrap();
        assert_eq!(parsed["name"], "他说\"你好\"\n第二行.docx");
        assert!(multipart_body("B", &metadata, b"x")
            .windows(metadata.len())
            .any(|w| w == metadata.as_bytes()));
    }

    #[test]
    fn clip_keeps_a_useful_prefix_and_hides_html() {
        // 超长正文截到 400 字并留一个省略号。
        let long = "啊".repeat(1000);
        let clipped = clip(&long);
        assert_eq!(clipped.chars().count(), 401);
        assert!(clipped.ends_with('…'));

        // 短正文原样返回，不加省略号。
        assert_eq!(clip("  invalid_client  "), "invalid_client");

        // 看着像网页的东西不能原样进到界面文字里 —— 那会是一整页
        // 别人家的 HTML 挤在 11px 的小字段落里。
        let html = clip("<!doctype html><html><body>Sign in</body></html>");
        assert!(!html.contains('<'));
        assert!(html.contains("网页"));
    }

    #[test]
    fn cancel_is_observable_and_connect_resets_it() {
        // 旗子本身是全局的，测试之间必须自己收拾干净。
        assert!(!CANCEL.load(Ordering::SeqCst));
        cancel();
        assert!(CANCEL.load(Ordering::SeqCst));
        CANCEL.store(false, Ordering::SeqCst);
        assert!(!CANCEL.load(Ordering::SeqCst));
    }

    #[test]
    fn query_value_ignores_pairs_without_an_equals_sign() {
        // 用 `?` 代替 continue 的写法会在这里返回 None，
        // 把一次本来能成功的授权变成「没等到回调」。
        let line = "GET /?garbage&code=abc123&state=xyz HTTP/1.1";
        assert_eq!(query_value(line, "code").as_deref(), Some("abc123"));
        assert_eq!(query_value(line, "state").as_deref(), Some("xyz"));
        assert_eq!(query_value(line, "missing"), None);
        // 没有查询串时不能 panic。
        assert_eq!(query_value("GET /favicon.ico HTTP/1.1", "code"), None);
        assert_eq!(query_value("", "code"), None);
    }

    #[test]
    fn a_callback_without_a_code_is_just_not_ours() {
        // 浏览器在回调之后还会来要 favicon，这一趟必须被安静地放过去，
        // 而不是当成授权失败。
        let out = parse_callback("GET /favicon.ico HTTP/1.1", "expected").unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn a_mismatched_state_is_refused_rather_than_exchanged() {
        let line = "GET /?code=abc&state=attacker HTTP/1.1";
        let err = parse_callback(line, "expected").unwrap_err();
        assert_eq!(err.kind, "google_state");
        // 对上了才放行。
        let ok = "GET /?code=abc&state=expected HTTP/1.1";
        assert_eq!(parse_callback(ok, "expected").unwrap().as_deref(), Some("abc"));
    }

    #[test]
    fn a_denied_authorization_reports_googles_own_reason() {
        let line = "GET /?error=access_denied&state=expected HTTP/1.1";
        let err = parse_callback(line, "expected").unwrap_err();
        assert_eq!(err.kind, "google_denied");
        assert!(err.message.contains("access_denied"));
    }

    #[test]
    fn the_authorization_url_asks_for_offline_access_and_pkce() {
        let url = build_auth_url(
            "cid.apps.googleusercontent.com",
            "http://127.0.0.1:51234",
            "st",
            "ch",
        )
        .unwrap();
        // 缺 access_type=offline 就拿不到 refresh token，用户每次都要重登；
        // 缺 prompt=consent，第二次授权同样不发 refresh token。
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("prompt=consent"));
        assert!(url.contains("code_challenge_method=S256"));
        // 回调地址里的 : 与 / 必须被转义，否则 Google 收到的是一个坏地址。
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A51234"));
        // 只申请非敏感的 drive.file，绝不写成 drive。
        assert!(url.contains("drive.file"));
        assert!(!url.contains("auth%2Fdrive%22") && !url.contains("auth/drive&"));
    }

    #[test]
    fn the_drive_name_drops_the_docx_suffix() {
        assert_eq!(drive_name("张三-简历.docx"), "张三-简历");
        assert_eq!(drive_name("张三-简历"), "张三-简历");
        assert_eq!(drive_name("  空白.docx  "), "空白");
        // 只剩后缀时不能产出空名字 —— Drive 会直接拒。
        assert_eq!(drive_name(".docx"), "未命名文档");
        assert_eq!(drive_name("   "), "未命名文档");
    }

    #[test]
    fn status_never_carries_a_secret() {
        let creds = GoogleCredentials {
            client_id: "cid.apps.googleusercontent.com".into(),
            client_secret: "GOCSPX-super-secret".into(),
            refresh_token: Some("1//refresh".into()),
        };
        let json = serde_json::to_value(GoogleStatus::of(Some(&creds))).unwrap();
        let text = json.to_string();
        assert!(!text.contains("GOCSPX"));
        assert!(!text.contains("refresh"));
        assert_eq!(json["configured"], true);
        assert_eq!(json["connected"], true);
        assert_eq!(json["clientId"], "cid.apps.googleusercontent.com");
    }

    #[test]
    fn status_reports_what_is_still_missing() {
        assert!(!GoogleStatus::of(None).configured);
        assert!(!GoogleStatus::of(None).connected);

        let only_client = GoogleCredentials {
            client_id: "cid.apps.googleusercontent.com".into(),
            client_secret: "s".into(),
            refresh_token: None,
        };
        let s = GoogleStatus::of(Some(&only_client));
        assert!(s.configured);
        assert!(!s.connected, "填了客户端字段不等于已经连上账号");

        let blank = GoogleCredentials::default();
        assert!(!GoogleStatus::of(Some(&blank)).configured, "空串不算填过");
    }

    #[test]
    fn saving_a_client_clears_any_previous_grant() {
        // 换 Client ID 等于换身份，旧 refresh token 必然被拒。
        // 留着它只会让下一次上传报一个用户看不懂的 invalid_client。
        let creds = GoogleCredentials {
            client_id: "old.apps.googleusercontent.com".into(),
            client_secret: "old".into(),
            refresh_token: Some("1//stale".into()),
        };
        let json = serde_json::to_string(&creds).unwrap();
        assert!(json.contains("refreshToken"));

        let cleared = GoogleCredentials {
            refresh_token: None,
            ..creds
        };
        assert!(!serde_json::to_string(&cleared).unwrap().contains("refreshToken"));
    }

    #[test]
    fn a_client_id_that_is_not_one_is_refused_with_the_usual_cause() {
        let err = save_client("1234567890", "GOCSPX-x").unwrap_err();
        assert_eq!(err.kind, "invalid");
        assert!(err.message.contains("apps.googleusercontent.com"));
        // 常见错法要写在错误里，否则用户只会反复粘贴同一个错的值。
        assert!(err.message.contains("API 密钥") || err.message.contains("项目编号"));

        let err = save_client("", "GOCSPX-x").unwrap_err();
        assert_eq!(err.kind, "invalid");
    }

    #[test]
    fn credentials_round_trip_through_the_stored_json() {
        let creds = GoogleCredentials {
            client_id: "cid.apps.googleusercontent.com".into(),
            client_secret: "GOCSPX-x".into(),
            refresh_token: Some("1//r".into()),
        };
        let back: GoogleCredentials =
            serde_json::from_str(&serde_json::to_string(&creds).unwrap()).unwrap();
        assert_eq!(back.client_id, creds.client_id);
        assert_eq!(back.refresh_token.as_deref(), Some("1//r"));
    }

    #[test]
    fn google_errors_are_translated_into_what_to_do_next() {
        // Google 的 error 是给机器读的枚举值，原样显示等于没说。
        let msg = describe_http_error(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"error":"invalid_client","error_description":"invalid_client"}"#,
        );
        assert!(msg.contains("401"));
        assert!(msg.contains("Client Secret"), "要给出下一步动作：{msg}");

        // error 也可能是对象形状（Drive 用这种）。
        let msg = describe_http_error(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"error":{"code":403,"message":"The user has not granted the app access"}}"#,
        );
        assert!(msg.contains("has not granted"));

        // 不是 JSON（比如网关回的 HTML 错误页）：状态码要留下，
        // 但那页 HTML 不能整段进界面 —— 一段几 KB 的 `<html>` 会把
        // 真正有用的那半句淹掉。这里钉住「码在、页不在」。
        let msg = describe_http_error(reqwest::StatusCode::BAD_GATEWAY, "<html>502</html>");
        assert!(msg.contains("502"), "{msg}");
        assert!(!msg.contains("<html>"), "网页正文不该进界面：{msg}");
        assert!(msg.contains("网页"), "要说明拿到的是什么东西：{msg}");
    }
}
