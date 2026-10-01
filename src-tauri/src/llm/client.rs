//! LLM 客户端：模型列表、连通性探测、生成。
//!
//! 只做传输 —— 不解释模型返回的 JSON 是不是一个合法的 `DesignSpec`。
//! 那是前端 `core/design/validate.ts` 的职责，放两份就会漂移。

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::error::{CommandError, Result};
use crate::providers::{Capabilities, ModelInfo, Protocol, ProbeResult, Provider};

use super::types::{ChatRequest, ChatResponse, ImageAttachment, OutputStrategy};

/// 生成可能很慢（长简历 + 思考型模型），但再慢也得有个头。
const TIMEOUT: Duration = Duration::from_secs(180);
/// 拉模型列表不该慢。
const LIST_TIMEOUT: Duration = Duration::from_secs(30);

/// 一个已经解析好的调用目标。
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub base_url: String,
    pub protocol: Protocol,
    pub api_key: String,
}

impl Endpoint {
    pub fn new(base_url: impl Into<String>, protocol: Protocol, api_key: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim().trim_end_matches('/').to_string(),
            protocol,
            api_key: api_key.into(),
        }
    }

    pub fn from_provider(provider: &Provider, api_key: String) -> Self {
        Self::new(provider.base_url.clone(), provider.protocol, api_key)
    }

    fn url(&self, path: &str) -> String {
        format!(
            "{}/{}",
            self.base_url.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }
}

/// 当前毫秒时间戳。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn http_client(timeout: Duration) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(timeout)
        // 有些端点会看 UA；带上自己的名字便于对方排查。
        .user_agent(concat!("resume-embellishment/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| CommandError::llm(format!("创建 HTTP 客户端失败：{e}")))
}

// ───────────────────────── 模型列表 ─────────────────────────

/// `GET {base}/models`。
pub async fn list_models(ep: &Endpoint) -> Result<Vec<ModelInfo>> {
    let resp = http_client(LIST_TIMEOUT)?
        .get(ep.url("models"))
        .bearer_auth(&ep.api_key)
        .send()
        .await
        .map_err(|e| transport_error(&ep.base_url, e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(http_error("拉取模型列表", status, &text));
    }

    let value: Value = serde_json::from_str(&text).map_err(|e| {
        CommandError::llm(format!(
            "模型列表不是合法 JSON：{e}\n原始响应前 400 字：{}",
            head(&text, 400)
        ))
    })?;
    Ok(parse_models(&value))
}

/// 从各种形状的响应里抠出模型列表。
///
/// OpenAI 是 `{data:[{id,...}]}`；有些兼容端点用 `{models:[...]}`，
/// 还有的直接回一个数组。三种都认，省得用户为端点的怪癖买单。
pub fn parse_models(value: &Value) -> Vec<ModelInfo> {
    let items = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .or_else(|| value.as_array());
    let Some(items) = items else { return Vec::new() };

    items
        .iter()
        .filter_map(|item| {
            let id = item
                .get("id")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)?
                .to_string();
            if id.trim().is_empty() {
                return None;
            }
            Some(ModelInfo {
                id,
                owned_by: item
                    .get("owned_by")
                    .or_else(|| item.get("ownedBy"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                created: item.get("created").and_then(Value::as_i64),
            })
        })
        .collect()
}

// ───────────────────────── 生成 ─────────────────────────

/// 调用模型生成内容。
pub async fn chat(ep: &Endpoint, model: &str, req: &ChatRequest) -> Result<ChatResponse> {
    let client = http_client(TIMEOUT)?;
    let mut note: Option<String> = None;
    let mut tried: Vec<&'static str> = Vec::new();

    for strategy in strategy_ladder(req.strategy) {
        tried.push(strategy.name());
        let (url, body) = build_request(ep, model, req, strategy);

        let resp = client
            .post(&url)
            .bearer_auth(&ep.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| transport_error(&ep.base_url, e))?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();

        if status.is_success() {
            let value: Value = serde_json::from_str(&text).map_err(|e| {
                CommandError::llm(format!(
                    "模型返回的不是合法 JSON：{e}\n原始响应前 400 字：{}",
                    head(&text, 400)
                ))
            })?;
            let content = extract_text(ep.protocol, &value);
            if content.trim().is_empty() {
                return Err(CommandError::llm(format!(
                    "模型返回了空内容。\n原始响应前 400 字：{}",
                    head(&text, 400)
                )));
            }
            return Ok(ChatResponse {
                text: content,
                strategy_used: strategy.name().to_string(),
                downgrade_note: note,
                usage: value.get("usage").cloned(),
            });
        }

        // 只有「端点不认识这个参数」才值得降级重试。
        // 401/403 是在说密钥不对、429 是在说太急、5xx 是端点自己崩了 ——
        // 这三种把结构化参数摘掉再试一遍只会更糟，还会多花用户的钱。
        if !is_retriable_status(status) {
            return Err(http_error("调用模型", status, &text));
        }
        if note.is_none() {
            note = Some(format!(
                "端点拒绝了 {} 结构化输出（HTTP {}），已自动降级重试。\n端点原话：{}",
                strategy.name(),
                status.as_u16(),
                head(&text, 240)
            ));
        }
    }

    Err(CommandError::llm(format!(
        "端点不接受任何结构化输出格式（依次试过 {}）。\n{}",
        tried.join(" → "),
        note.unwrap_or_default()
    )))
}

fn strategy_ladder(requested: OutputStrategy) -> Vec<OutputStrategy> {
    match requested {
        OutputStrategy::JsonSchema => vec![
            OutputStrategy::JsonSchema,
            OutputStrategy::JsonObject,
            OutputStrategy::Text,
        ],
        OutputStrategy::JsonObject => vec![OutputStrategy::JsonObject, OutputStrategy::Text],
        OutputStrategy::Text => vec![OutputStrategy::Text],
    }
}

fn is_retriable_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::BAD_REQUEST
        || status == reqwest::StatusCode::UNPROCESSABLE_ENTITY
        || status == reqwest::StatusCode::NOT_IMPLEMENTED
        || status == reqwest::StatusCode::UNSUPPORTED_MEDIA_TYPE
}

/// 摘掉 JSON Schema 里 Gemini 接受不了的 `enum` 成员。
///
/// Gemini 的 `Schema.enum` 是 `repeated string` —— 成员不是字符串时端点直接回
///
/// ```text
/// HTTP 400 Invalid value at '…response_schema.properties[2]…enum[0]' (TYPE_STRING)
/// ```
///
/// 中转端点会把 OpenAI 的 `response_format.json_schema.schema` 原样映射成
/// `generation_config.response_schema`，于是「一份合法的 JSON Schema」在这里
/// 变成了一次硬失败 —— 这正是 `enum: [1]` / `enum: [1, 2]` 曾经的遭遇。
///
/// 前端 `core/design/spec.ts` 已经改用 `minimum` / `maximum` 表达整数区间，
/// 这里是**第二道防线**：将来谁往 schema 里加了非字符串 enum，也不该让整个
/// 功能挂掉。非字符串成员一律摘掉；摘空了就把 `enum` 整条删掉 —— 少一条给模型的
/// 提示不吃亏，真正的把关在客户端 zod 那一层。
pub fn sanitize_schema(schema: &Value) -> Value {
    match schema {
        Value::Array(items) => Value::Array(items.iter().map(sanitize_schema).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (key, value) in map {
                if key == "enum" {
                    if let Value::Array(members) = value {
                        let strings: Vec<Value> = members
                            .iter()
                            .filter(|m| m.is_string())
                            .cloned()
                            .collect();
                        // 一个都不剩就整条删掉：空的 `enum` 比没有 `enum` 更糟。
                        if strings.is_empty() {
                            continue;
                        }
                        out.insert(key.clone(), Value::Array(strings));
                        continue;
                    }
                }
                out.insert(key.clone(), sanitize_schema(value));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// 把文字与附图拼成 Chat Completions 的 `content`。
///
/// ⚠ 没有图时**必须**回一个纯字符串，而不是「只含一个 text 分段的数组」。
/// 很多中转端点对数组形式的 content 有不同的代码路径（有的直接报错），
/// 而我们绝大多数请求都是纯文本 —— 不该为少数情况让所有人都走那条路。
fn chat_content(user: &str, images: &[ImageAttachment]) -> Value {
    let usable: Vec<&ImageAttachment> = images
        .iter()
        .filter(|img| !img.data_base64.trim().is_empty())
        .collect();

    if usable.is_empty() {
        return json!(user);
    }

    let mut parts = vec![json!({ "type": "text", "text": user })];
    for img in usable {
        parts.push(json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{};base64,{}", img.mime, img.data_base64) }
        }));
    }
    json!(parts)
}

/// 把文字与附图拼成 Responses 协议的 `input`。
///
/// 结构与 Chat Completions 不同：分段类型叫 `input_text` / `input_image`，
/// 且图片直接吃 data URL 的 `image_url` 字符串（不是嵌套对象）。
fn responses_input(user: &str, images: &[ImageAttachment]) -> Value {
    let usable: Vec<&ImageAttachment> = images
        .iter()
        .filter(|img| !img.data_base64.trim().is_empty())
        .collect();

    if usable.is_empty() {
        return json!(user);
    }

    let mut parts = vec![json!({ "type": "input_text", "text": user })];
    for img in usable {
        parts.push(json!({
            "type": "input_image",
            "image_url": format!("data:{};base64,{}", img.mime, img.data_base64)
        }));
    }
    json!([{ "role": "user", "content": parts }])
}

/// 思考强度白名单。
///
/// 存盘里那个值是自由字符串（`ModelSettings.reasoning_effort` 特意没用枚举，
/// 免得手改出一个将来才支持的值就让整份 providers.json 读不出来），
/// 所以发请求前在这里收口：**认不出的值直接丢掉，不原样发下去**。
/// 发下去只会换回一个 400，而那个错误信息不会告诉用户是这里的问题；
/// 丢掉最多是这个设置没生效，而且界面本来就只提供这六个选项。
fn reasoning_effort_value(raw: &str) -> Option<&'static str> {
    const KNOWN: [&str; 6] = ["none", "low", "medium", "high", "xhigh", "max"];
    KNOWN.into_iter().find(|k| *k == raw)
}

/// 拼出一次请求的 URL 与请求体。
///
/// 两种协议的结构化输出参数长得完全不一样：
/// Chat Completions 用 `response_format`，Responses 用 `text.format`。
/// 在同一个函数里分叉是为了让人一眼看出这个差异，而不是散在两处。
pub fn build_request(
    ep: &Endpoint,
    model: &str,
    req: &ChatRequest,
    strategy: OutputStrategy,
) -> (String, Value) {
    match ep.protocol {
        Protocol::ChatCompletions => {
            let mut body = json!({
                "model": model,
                "messages": [
                    { "role": "system", "content": req.system },
                    { "role": "user", "content": chat_content(&req.user, &req.images) },
                ],
                // 明确关闭流式：前端要的是一整段文本，流式只会让这一层复杂一倍。
                "stream": false,
            });
            if let Some(n) = req.max_output_tokens {
                body["max_tokens"] = json!(n);
            }
            if let Some(t) = req.temperature {
                body["temperature"] = json!(t);
            }
            if let Some(e) = req.reasoning_effort.as_deref().and_then(reasoning_effort_value) {
                body["reasoning_effort"] = json!(e);
            }
            match strategy {
                OutputStrategy::JsonSchema => {
                    if let Some(schema) = &req.json_schema {
                        body["response_format"] = json!({
                            "type": "json_schema",
                            "json_schema": {
                                "name": "design_spec",
                                "schema": sanitize_schema(schema),
                                "strict": true
                            }
                        });
                    }
                }
                OutputStrategy::JsonObject => {
                    body["response_format"] = json!({ "type": "json_object" });
                }
                OutputStrategy::Text => {}
            }
            (ep.url("chat/completions"), body)
        }
        Protocol::Responses => {
            let mut body = json!({
                "model": model,
                "instructions": req.system,
                "input": responses_input(&req.user, &req.images),
                "stream": false,
            });
            if let Some(n) = req.max_output_tokens {
                body["max_output_tokens"] = json!(n);
            }
            if let Some(t) = req.temperature {
                body["temperature"] = json!(t);
            }
            // Responses 协议里思考强度是嵌套的 `reasoning.effort`，
            // 不是 Chat Completions 那个平铺的 `reasoning_effort`。
            if let Some(e) = req.reasoning_effort.as_deref().and_then(reasoning_effort_value) {
                body["reasoning"] = json!({ "effort": e });
            }
            match strategy {
                OutputStrategy::JsonSchema => {
                    if let Some(schema) = &req.json_schema {
                        body["text"] = json!({
                            "format": {
                                "type": "json_schema",
                                "name": "design_spec",
                                "schema": sanitize_schema(schema),
                                "strict": true
                            }
                        });
                    }
                }
                OutputStrategy::JsonObject => {
                    body["text"] = json!({ "format": { "type": "json_object" } });
                }
                OutputStrategy::Text => {}
            }
            (ep.url("responses"), body)
        }
    }
}

/// 从响应里取出助手正文。
pub fn extract_text(protocol: Protocol, value: &Value) -> String {
    match protocol {
        Protocol::ChatCompletions => {
            if let Some(s) = value
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
            {
                return s.to_string();
            }
            // content 有时是分段数组（多模态端点）。
            if let Some(parts) = value
                .pointer("/choices/0/message/content")
                .and_then(Value::as_array)
            {
                let joined: String = parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .collect();
                if !joined.trim().is_empty() {
                    return joined;
                }
            }
            // 少数兼容端点沿用 completions 的字段名。
            value
                .pointer("/choices/0/text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        }
        Protocol::Responses => {
            if let Some(s) = value.get("output_text").and_then(Value::as_str) {
                return s.to_string();
            }
            // 逐段拼：output[].content[].text
            let mut out = String::new();
            if let Some(items) = value.get("output").and_then(Value::as_array) {
                for item in items {
                    if let Some(parts) = item.get("content").and_then(Value::as_array) {
                        for part in parts {
                            if let Some(t) = part.get("text").and_then(Value::as_str) {
                                out.push_str(t);
                            }
                        }
                    }
                }
            }
            out
        }
    }
}

// ───────────────────────── 连通性探测 ─────────────────────────

/// 测一次连通性，顺带问出端点真实支持哪些结构化输出。
pub async fn probe(ep: &Endpoint, model: &str) -> ProbeResult {
    let started = Instant::now();
    let request = ChatRequest {
        system: "你是一个连通性测试端点。".to_string(),
        user: "只回复两个字：可用".to_string(),
        strategy: OutputStrategy::Text,
        json_schema: None,
        max_output_tokens: Some(16),
        images: Vec::new(),
        // 刻意不带用户设的温度与思考强度：
        // 这是连通性测试，要回答的是「这个端点通不通、支持什么」。
        // 带上一个端点不认的参数只会让它因为别的原因失败，
        // 用户看到「测试不通过」就再也不敢用了。
        temperature: None,
        reasoning_effort: None,
    };

    match chat(ep, model, &request).await {
        Err(e) => ProbeResult {
            ok: false,
            latency_ms: None,
            error: Some(e.message),
            capabilities: None,
            at: now_ms(),
        },
        Ok(_) => ProbeResult {
            ok: true,
            latency_ms: Some(started.elapsed().as_millis() as u64),
            error: None,
            capabilities: Some(probe_capabilities(ep, model).await),
            at: now_ms(),
        },
    }
}

/// 逐个试出端点真实支持的能力。
///
/// **不猜**：一个"支持 JSON"的端点常常只认 `json_object` 而不认
/// `json_schema`，猜错的结果是用户第一次点生成就失败 ——
/// 而且是那种看不出所以然的失败。
async fn probe_capabilities(ep: &Endpoint, model: &str) -> Capabilities {
    let schema = json!({
        "type": "object",
        "properties": { "ok": { "type": "boolean" } },
        "required": ["ok"]
    });
    let json_schema = try_strategy(ep, model, OutputStrategy::JsonSchema, Some(schema)).await;
    // json_schema 通了就不必再试 json_object —— 支持前者必然支持后者，
    // 少一次调用就少一分等待与花费。
    let json_object =
        json_schema || try_strategy(ep, model, OutputStrategy::JsonObject, None).await;

    Capabilities {
        json_schema,
        json_object,
        // 本应用从不做流式调用，这里报 false 是事实，不是能力缺失。
        streaming: false,
        list_models: list_models(ep).await.is_ok(),
    }
}

async fn try_strategy(
    ep: &Endpoint,
    model: &str,
    strategy: OutputStrategy,
    json_schema: Option<Value>,
) -> bool {
    let request = ChatRequest {
        system: "连通性测试。".to_string(),
        user: "返回 {\"ok\":true}".to_string(),
        strategy,
        json_schema,
        max_output_tokens: Some(24),
        images: Vec::new(),
        // 同 `probe`：能力探测只关心端点认不认这种结构化输出格式
        temperature: None,
        reasoning_effort: None,
    };
    chat(ep, model, &request).await.is_ok()
}

// ───────────────────────── 错误文案 ─────────────────────────

fn transport_error(base_url: &str, e: reqwest::Error) -> CommandError {
    let hint = if e.is_timeout() {
        "\n（超时了。检查网络或代理，也可能是端点本身很慢。）"
    } else if e.is_connect() {
        "\n（连不上。检查 Base URL 是否写全，比如 https://api.example.com/v1。）"
    } else {
        ""
    };
    CommandError::llm(format!("请求 {base_url} 失败：{e}{hint}"))
}

fn http_error(what: &str, status: reqwest::StatusCode, body: &str) -> CommandError {
    let hint = match status.as_u16() {
        401 | 403 => "\n（密钥不对，或者这个密钥没有调用该模型的权限。）",
        404 => "\n（路径不存在。多数端点的 Base URL 要精确到 /v1。）",
        429 => "\n（请求太频繁，或额度已经用尽。）",
        s if s >= 500 => "\n（端点自己出错了，等一会儿再试。）",
        _ => "",
    };
    CommandError::llm(format!(
        "{what}失败：HTTP {}{}{hint}\n端点返回：{}",
        status.as_u16(),
        status
            .canonical_reason()
            .map(|r| format!(" {r}"))
            .unwrap_or_default(),
        head(body, 400)
    ))
}

/// 截断到 `n` 个字符（按字符而不是字节，免得把中文切一半）。
fn head(text: &str, n: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= n {
        trimmed.to_string()
    } else {
        format!("{}…", trimmed.chars().take(n).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(protocol: Protocol) -> Endpoint {
        Endpoint::new("https://api.example.com/v1/", protocol, "sk-test")
    }

    fn request(strategy: OutputStrategy) -> ChatRequest {
        ChatRequest {
            system: "系统".to_string(),
            user: "用户".to_string(),
            strategy,
            json_schema: Some(json!({ "type": "object" })),
            max_output_tokens: Some(1024),
            images: Vec::new(),
            temperature: None,
            reasoning_effort: None,
        }
    }

    fn request_with_images(strategy: OutputStrategy) -> ChatRequest {
        ChatRequest {
            images: vec![ImageAttachment {
                mime: "image/png".to_string(),
                data_base64: "aGVsbG8=".to_string(),
                name: Some("剪贴板图片 1".to_string()),
            }],
            ..request(strategy)
        }
    }

    #[test]
    fn base_url_is_normalized_once() {
        let e = Endpoint::new(" https://api.example.com/v1/// ", Protocol::ChatCompletions, "k");
        assert_eq!(e.base_url, "https://api.example.com/v1");
        assert_eq!(e.url("models"), "https://api.example.com/v1/models");
    }

    #[test]
    fn without_images_the_content_stays_a_plain_string() {
        // 绝大多数请求都是纯文本。content 变成数组会让部分中转端点走另一条
        // 代码路径（有的直接报错），所以无图时必须原样保持字符串。
        let (_, body) = build_request(&ep(Protocol::ChatCompletions), "m", &request(OutputStrategy::Text), OutputStrategy::Text);
        assert_eq!(body["messages"][1]["content"], json!("用户"));

        let (_, body) = build_request(&ep(Protocol::Responses), "m", &request(OutputStrategy::Text), OutputStrategy::Text);
        assert_eq!(body["input"], json!("用户"));
    }

    #[test]
    fn sampling_settings_are_absent_unless_the_user_sets_them() {
        // 没设过就一个键都不能多 —— 老前端、老配置发出的请求体
        // 必须与从前逐字一致，否则等于给所有用户换了一套请求。
        for protocol in [Protocol::ChatCompletions, Protocol::Responses] {
            let (_, body) = build_request(
                &ep(protocol),
                "m",
                &request(OutputStrategy::Text),
                OutputStrategy::Text,
            );
            assert!(body.get("temperature").is_none(), "{protocol:?}");
            assert!(body.get("reasoning_effort").is_none(), "{protocol:?}");
            assert!(body.get("reasoning").is_none(), "{protocol:?}");
        }
    }

    #[test]
    fn temperature_is_sent_top_level_on_both_protocols() {
        let req = ChatRequest {
            temperature: Some(0.7),
            ..request(OutputStrategy::Text)
        };

        for protocol in [Protocol::ChatCompletions, Protocol::Responses] {
            let (_, body) = build_request(&ep(protocol), "m", &req, OutputStrategy::Text);
            assert_eq!(body["temperature"], json!(0.7), "{protocol:?}");
        }

        // 0 是合法温度，不能被当成「没填」丢掉
        let zero = ChatRequest {
            temperature: Some(0.0),
            ..request(OutputStrategy::Text)
        };
        let (_, body) = build_request(&ep(Protocol::ChatCompletions), "m", &zero, OutputStrategy::Text);
        assert_eq!(body["temperature"], json!(0.0));
    }

    #[test]
    fn reasoning_effort_is_flat_on_chat_completions_and_nested_on_responses() {
        // 两个协议的参数形状不一样：平铺 `reasoning_effort`
        // vs 嵌套 `reasoning.effort`。写错的那个会被端点忽略或报错。
        let req = ChatRequest {
            reasoning_effort: Some("high".to_string()),
            ..request(OutputStrategy::Text)
        };

        let (_, chat) = build_request(&ep(Protocol::ChatCompletions), "m", &req, OutputStrategy::Text);
        assert_eq!(chat["reasoning_effort"], json!("high"));
        assert!(chat.get("reasoning").is_none());

        let (_, res) = build_request(&ep(Protocol::Responses), "m", &req, OutputStrategy::Text);
        assert_eq!(res["reasoning"]["effort"], json!("high"));
        assert!(res.get("reasoning_effort").is_none());
    }

    #[test]
    fn an_unknown_reasoning_effort_is_dropped_rather_than_sent() {
        // 存盘里那个值是自由字符串（手改得出来）。认不出就丢掉：
        // 原样发下去只会换回一个 400，而那个错误说不清是这里的问题。
        let req = ChatRequest {
            reasoning_effort: Some("very-high".to_string()),
            ..request(OutputStrategy::Text)
        };

        for protocol in [Protocol::ChatCompletions, Protocol::Responses] {
            let (_, body) = build_request(&ep(protocol), "m", &req, OutputStrategy::Text);
            assert!(body.get("reasoning_effort").is_none(), "{protocol:?}");
            assert!(body.get("reasoning").is_none(), "{protocol:?}");
        }
    }

    #[test]
    fn chat_completions_sends_images_as_data_urls() {
        let (_, body) = build_request(
            &ep(Protocol::ChatCompletions),
            "m",
            &request_with_images(OutputStrategy::JsonSchema),
            OutputStrategy::JsonSchema,
        );
        let content = body["messages"][1]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "用户");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(
            content[1]["image_url"]["url"],
            "data:image/png;base64,aGVsbG8="
        );
    }

    #[test]
    fn responses_sends_images_in_its_own_shape() {
        // Responses 的分段类型叫 input_text / input_image，且 image_url
        // 直接是字符串。照抄 Chat Completions 的结构会被端点拒绝。
        let (_, body) = build_request(
            &ep(Protocol::Responses),
            "m",
            &request_with_images(OutputStrategy::Text),
            OutputStrategy::Text,
        );
        let content = body["input"][0]["content"].as_array().unwrap();
        assert_eq!(body["input"][0]["role"], "user");
        assert_eq!(content[0]["type"], "input_text");
        assert_eq!(content[1]["type"], "input_image");
        assert_eq!(content[1]["image_url"], "data:image/png;base64,aGVsbG8=");
    }

    #[test]
    fn an_image_with_no_payload_is_skipped_not_sent_empty() {
        // 空的 base64 会拼出一个 `data:image/png;base64,` —— 端点只会回 400，
        // 而错误信息完全指不到真正的原因。宁可不发这张图。
        let mut req = request_with_images(OutputStrategy::Text);
        req.images[0].data_base64 = "   ".to_string();
        let (_, body) = build_request(&ep(Protocol::ChatCompletions), "m", &req, OutputStrategy::Text);
        // 全被跳过时回落成纯字符串，而不是只剩一个 text 分段的数组。
        assert_eq!(body["messages"][1]["content"], json!("用户"));
    }

    #[test]
    fn non_string_enum_members_are_stripped_from_the_schema() {
        // Gemini 的 Schema.enum 是 repeated string：数字成员会让端点直接回 400。
        let schema = json!({
            "type": "object",
            "properties": {
                "version": { "type": "integer", "enum": [1] },
                "columns": { "type": "integer", "enum": [1, 2] },
                "template": { "type": "string", "enum": ["single-column", "two-column-left"] },
            },
        });
        let clean = sanitize_schema(&schema);

        // 纯数字的 enum 整条消失（摘空之后留着比不留更糟）。
        assert!(clean["properties"]["version"].get("enum").is_none());
        assert!(clean["properties"]["columns"].get("enum").is_none());
        // integer 本身保留 —— 只有 enum 是端点接受不了的。
        assert_eq!(clean["properties"]["version"]["type"], "integer");

        // 字符串 enum 原样保留。
        assert_eq!(
            clean["properties"]["template"]["enum"],
            json!(["single-column", "two-column-left"])
        );
    }

    #[test]
    fn mixed_enum_keeps_only_the_string_members() {
        let schema = json!({ "anyOf": [{ "type": "string", "enum": ["a", 1, "b", true] }] });
        let clean = sanitize_schema(&schema);
        assert_eq!(clean["anyOf"][0]["enum"], json!(["a", "b"]));
    }

    #[test]
    fn sanitizing_leaves_an_already_clean_schema_untouched() {
        let schema = json!({
            "type": "object",
            "required": ["a"],
            "properties": { "a": { "type": "string", "pattern": "^x$" } },
        });
        assert_eq!(sanitize_schema(&schema), schema);
    }

    #[test]
    fn the_shipped_schema_carries_no_non_string_enum() {
        // 守住前端 spec.ts 与这道防线之间的一致性：
        // 若哪天有人在 DESIGN_SPEC_JSON_SCHEMA 里塞回 `enum: [1]`，这里也照样安全。
        let shaped = json!({
            "type": "object",
            "properties": {
                "version": { "type": "integer", "minimum": 1, "maximum": 1 },
                "sections": {
                    "type": "array",
                    "items": {
                        "properties": { "style": { "properties": {
                            "columns": { "type": "integer", "minimum": 1, "maximum": 2 }
                        } } }
                    }
                },
            },
        });
        assert_eq!(sanitize_schema(&shaped), shaped);
    }

    #[test]
    fn chat_completions_puts_the_schema_in_response_format() {
        let (url, body) = build_request(
            &ep(Protocol::ChatCompletions),
            "gpt-4o",
            &request(OutputStrategy::JsonSchema),
            OutputStrategy::JsonSchema,
        );
        assert_eq!(url, "https://api.example.com/v1/chat/completions");
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(body["response_format"]["json_schema"]["name"], "design_spec");
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["stream"], false);
    }

    #[test]
    fn responses_puts_the_schema_in_text_format() {
        let (url, body) = build_request(
            &ep(Protocol::Responses),
            "gpt-5",
            &request(OutputStrategy::JsonSchema),
            OutputStrategy::JsonSchema,
        );
        assert_eq!(url, "https://api.example.com/v1/responses");
        assert_eq!(body["text"]["format"]["type"], "json_schema");
        assert_eq!(body["max_output_tokens"], 1024);
        // Responses 协议用 instructions / input，而不是 messages。
        assert_eq!(body["instructions"], "系统");
        assert!(body.get("messages").is_none());
    }

    #[test]
    fn plain_text_strategy_sends_no_structured_parameters() {
        for protocol in [Protocol::ChatCompletions, Protocol::Responses] {
            let (_, body) = build_request(
                &ep(protocol),
                "m",
                &request(OutputStrategy::Text),
                OutputStrategy::Text,
            );
            assert!(body.get("response_format").is_none());
            assert!(body.get("text").is_none());
        }
    }

    #[test]
    fn json_object_strategy_is_supported_by_both_protocols() {
        let (_, body) = build_request(
            &ep(Protocol::ChatCompletions),
            "m",
            &request(OutputStrategy::JsonObject),
            OutputStrategy::JsonObject,
        );
        assert_eq!(body["response_format"]["type"], "json_object");

        let (_, body) = build_request(
            &ep(Protocol::Responses),
            "m",
            &request(OutputStrategy::JsonObject),
            OutputStrategy::JsonObject,
        );
        assert_eq!(body["text"]["format"]["type"], "json_object");
    }

    #[test]
    fn schema_strategy_without_a_schema_sends_nothing_extra() {
        let mut req = request(OutputStrategy::JsonSchema);
        req.json_schema = None;
        let (_, body) = build_request(
            &ep(Protocol::ChatCompletions),
            "m",
            &req,
            OutputStrategy::JsonSchema,
        );
        assert!(body.get("response_format").is_none());
    }

    #[test]
    fn ladder_degrades_one_step_at_a_time() {
        assert_eq!(
            strategy_ladder(OutputStrategy::JsonSchema),
            vec![
                OutputStrategy::JsonSchema,
                OutputStrategy::JsonObject,
                OutputStrategy::Text
            ]
        );
        assert_eq!(
            strategy_ladder(OutputStrategy::JsonObject),
            vec![OutputStrategy::JsonObject, OutputStrategy::Text]
        );
        assert_eq!(strategy_ladder(OutputStrategy::Text), vec![OutputStrategy::Text]);
    }

    #[test]
    fn auth_and_rate_limit_failures_are_not_retried() {
        // 这三类不是「参数不认识」，重试只会多花钱。
        assert!(!is_retriable_status(reqwest::StatusCode::UNAUTHORIZED));
        assert!(!is_retriable_status(reqwest::StatusCode::FORBIDDEN));
        assert!(!is_retriable_status(reqwest::StatusCode::TOO_MANY_REQUESTS));
        assert!(!is_retriable_status(reqwest::StatusCode::INTERNAL_SERVER_ERROR));
        // 这两类是典型的「不认识这个参数」。
        assert!(is_retriable_status(reqwest::StatusCode::BAD_REQUEST));
        assert!(is_retriable_status(reqwest::StatusCode::UNPROCESSABLE_ENTITY));
    }

    #[test]
    fn parse_models_accepts_three_shapes() {
        let openai = json!({ "data": [{ "id": "a", "owned_by": "x" }, { "id": "b" }] });
        assert_eq!(parse_models(&openai).len(), 2);
        assert_eq!(parse_models(&openai)[0].owned_by.as_deref(), Some("x"));

        let alt = json!({ "models": [{ "name": "c" }] });
        assert_eq!(parse_models(&alt)[0].id, "c");

        let bare = json!([{ "id": "d" }]);
        assert_eq!(parse_models(&bare)[0].id, "d");

        assert!(parse_models(&json!({ "nope": 1 })).is_empty());
    }

    #[test]
    fn parse_models_skips_entries_without_an_id() {
        let value = json!({ "data": [{ "owned_by": "x" }, { "id": "" }, { "id": "ok" }] });
        let models = parse_models(&value);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "ok");
    }

    #[test]
    fn extract_text_reads_chat_completions() {
        let value = json!({ "choices": [{ "message": { "content": "你好" } }] });
        assert_eq!(extract_text(Protocol::ChatCompletions, &value), "你好");

        let parts = json!({ "choices": [{ "message": { "content": [{ "text": "a" }, { "text": "b" }] } }] });
        assert_eq!(extract_text(Protocol::ChatCompletions, &parts), "ab");
    }

    #[test]
    fn extract_text_reads_responses() {
        let short = json!({ "output_text": "直接给" });
        assert_eq!(extract_text(Protocol::Responses, &short), "直接给");

        let long = json!({
            "output": [
                { "content": [{ "text": "第一段" }] },
                { "content": [{ "text": "第二段" }] }
            ]
        });
        assert_eq!(extract_text(Protocol::Responses, &long), "第一段第二段");
    }

    #[test]
    fn extract_text_returns_empty_rather_than_panicking_on_junk() {
        assert_eq!(extract_text(Protocol::ChatCompletions, &json!({})), "");
        assert_eq!(extract_text(Protocol::Responses, &json!({ "output": 3 })), "");
    }

    #[test]
    fn head_counts_characters_not_bytes() {
        assert_eq!(head("  你好世界  ", 2), "你好…");
        assert_eq!(head("你好", 10), "你好");
    }

    #[test]
    fn http_error_explains_the_common_failures() {
        let e = http_error("调用模型", reqwest::StatusCode::UNAUTHORIZED, "bad key");
        assert!(e.message.contains("401"));
        assert!(e.message.contains("密钥"));
        assert!(e.message.contains("bad key"));
    }

    #[test]
    fn now_ms_is_a_sane_epoch_millisecond() {
        // 2020-01-01 之后才有意义。
        assert!(now_ms() > 1_577_836_800_000);
    }
}
