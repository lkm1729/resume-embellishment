//! LLM 传输层类型。
//!
//! 与前端 `src/core/llm/api.ts` 的 `ChatRequestPayload` / `ChatResponsePayload`
//! 一一对应，字段名 camelCase。

use serde::{Deserialize, Serialize};

/// 结构化输出的策略。名称与前端 `OutputStrategy` 完全一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputStrategy {
    /// 最理想：给出 JSON Schema，端点保证结构。
    JsonSchema,
    /// 次之：只要求「回一个 JSON 对象」。
    JsonObject,
    /// 兜底：纯文本，JSON 由前端自己抠。
    Text,
}

impl OutputStrategy {
    /// 机器可读名，也是回给前端的 `strategyUsed`。
    pub fn name(self) -> &'static str {
        match self {
            OutputStrategy::JsonSchema => "json_schema",
            OutputStrategy::JsonObject => "json_object",
            OutputStrategy::Text => "text",
        }
    }
}

/// 随请求一起发给模型的图片（用户从剪贴板粘贴的设计参考）。
///
/// 刻意只收 base64 而不是路径：图是用户从剪贴板来的，**根本没有文件**。
/// 让前端把字节读出来、后端只负责拼进请求体，是唯一不依赖文件系统的做法。
///
/// ⚠ 这里不做尺寸校验。压缩发生在界面侧（canvas 重编码），
/// 因为只有那里能真正把图变小；后端拒绝一张 8MB 的截图只会让用户困惑，
/// 他既看不懂也改不了。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    /// 如 `image/png`、`image/jpeg`。作为 data URL 的前缀原样下发给端点。
    pub mime: String,
    /// **不含** `data:` 前缀的纯 base64。
    #[serde(default)]
    pub data_base64: String,
    /// 展示用的名字（如「剪贴板图片 1」），只进 prompt 文字，不进请求体的图片字段。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// 生成请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub system: String,
    pub user: String,
    pub strategy: OutputStrategy,
    /// JSON Schema 由前端从 `DesignSpec` 的校验器生成 ——
    /// 后端不重复定义一遍结构，否则两处会漂移。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json_schema: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    /// 多模态附图。为空时请求体与从前完全一致（纯文本字符串 content），
    /// 这样不支持视觉的模型不会因为一个空数组而收到陌生结构。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageAttachment>,
    /// 采样温度。**不填就不发这个参数** ——
    /// 发 `temperature: null` 或发一个端点不认的字段都会换来 400，
    /// 而默认该由端点自己决定。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// 思考强度。同样是「不填就不发」：
    /// 只有部分端点认这个参数，认不出的实现可能直接报错。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

/// 生成响应。
///
/// **纯传输**：返回模型原始文本。提取 JSON、校验、修复轮都在前端
/// `core/design/generate.ts` 里做。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    pub text: String,
    /// 实际生效的策略 —— 端点不支持时会自动降级，所以不一定等于请求的那个。
    pub strategy_used: String,
    /// 发生过降级时的说明。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downgrade_note: Option<String>,
    /// 原样透传的 usage，界面可以显示 token 数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strategy_names_match_the_frontend() {
        assert_eq!(OutputStrategy::JsonSchema.name(), "json_schema");
        assert_eq!(OutputStrategy::JsonObject.name(), "json_object");
        assert_eq!(OutputStrategy::Text.name(), "text");
    }

    #[test]
    fn request_reads_camel_case_from_the_frontend() {
        let raw = r#"{
            "system": "s",
            "user": "u",
            "strategy": "json_schema",
            "jsonSchema": { "type": "object" },
            "maxOutputTokens": 4096
        }"#;
        let req: ChatRequest = serde_json::from_str(raw).unwrap();
        assert_eq!(req.strategy, OutputStrategy::JsonSchema);
        assert_eq!(req.max_output_tokens, Some(4096));
        assert!(req.json_schema.is_some());
    }

    #[test]
    fn request_tolerates_the_optional_fields_being_absent() {
        let raw = r#"{ "system": "s", "user": "u", "strategy": "text" }"#;
        let req: ChatRequest = serde_json::from_str(raw).unwrap();
        assert_eq!(req.strategy, OutputStrategy::Text);
        assert!(req.json_schema.is_none());
        assert!(req.max_output_tokens.is_none());
        // 老前端不带 images 也必须能解析 —— 否则升级会变成硬故障。
        assert!(req.images.is_empty());
    }

    #[test]
    fn images_are_read_from_the_frontend() {
        let raw = r#"{
            "system": "s",
            "user": "u",
            "strategy": "json_schema",
            "images": [
                { "mime": "image/png", "dataBase64": "AAA=", "name": "剪贴板图片 1" }
            ]
        }"#;
        let req: ChatRequest = serde_json::from_str(raw).unwrap();
        assert_eq!(req.images.len(), 1);
        assert_eq!(req.images[0].mime, "image/png");
        assert_eq!(req.images[0].name.as_deref(), Some("剪贴板图片 1"));
    }

    #[test]
    fn an_empty_image_list_is_not_serialized() {
        let req = ChatRequest {
            system: "s".into(),
            user: "u".into(),
            strategy: OutputStrategy::Text,
            json_schema: None,
            max_output_tokens: None,
            images: Vec::new(),
            temperature: None,
            reasoning_effort: None,
        };
        let json = serde_json::to_value(&req).unwrap();
        // 无图时请求体不该多出一个陌生字段 —— 有些端点对未知字段很挑剔。
        assert!(json.get("images").is_none());
        // 采样参数同理：没设过就不该出现在请求体里
        assert!(json.get("temperature").is_none());
        assert!(json.get("reasoningEffort").is_none());
    }

    #[test]
    fn sampling_settings_read_from_the_frontend_as_camel_case() {
        let raw = r#"{
            "system": "s",
            "user": "u",
            "strategy": "text",
            "temperature": 0.3,
            "reasoningEffort": "medium"
        }"#;
        let req: ChatRequest = serde_json::from_str(raw).unwrap();
        assert_eq!(req.temperature, Some(0.3));
        assert_eq!(req.reasoning_effort.as_deref(), Some("medium"));
    }

    #[test]
    fn response_omits_absent_optionals() {
        let resp = ChatResponse {
            text: "{}".to_string(),
            strategy_used: "text".to_string(),
            downgrade_note: None,
            usage: None,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["strategyUsed"], "text");
        assert!(json.get("downgradeNote").is_none());
        assert!(json.get("usage").is_none());
    }
}
