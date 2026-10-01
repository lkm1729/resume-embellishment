//! 供应商配置。
//!
//! 与前端 `src/core/llm/types.ts` 一一对应，字段名统一 camelCase。
//! **这里没有 apiKey 字段** —— 密钥在 Windows 凭据管理器里，
//! 配置里只有 `secretRef` 这个名字。

use serde::{Deserialize, Serialize};

use crate::error::{CommandError, Result};
use crate::persist;

/// 接口协议。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    /// 兼容性最广，绝大多数第三方与自建端点都支持。
    ChatCompletions,
    /// OpenAI 新协议，部分兼容端点尚未实现。
    Responses,
}

/// 单个模型的自定义参数。
///
/// 挂在模型上而不是供应商上：同一个中转站下面，各模型的能力差别
/// 往往比不同供应商之间还大。
///
/// 每个字段都是 `Option` —— 不填就是「不要替我决定」，
/// 序列化时整键消失，所以老配置文件读得进来、新配置也不会多出空对象。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettings {
    /// 采样温度。不填则用端点默认值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// 思考强度。存字符串而不是枚举：这份文件是用户数据，
    /// 手改出一个将来才支持的值不该让整个 providers.json 读不出来。
    /// 真正的合法性检查在发请求时做（`llm::client::build_request`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// 是否支持结构化输出；`None` 表示跟随探测结果。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_output: Option<bool>,
    /// 是否支持多模态（图片）；`None` 表示支持。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multimodal: Option<bool>,
}

/// 用户自定义的模型条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    /// 实际调用时传给 API 的模型 ID。
    pub id: String,
    /// 用户可读的显示名；为空时界面回退显示 `id`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// 这个模型的自定义参数；为空表示全部跟随端点默认与探测结果。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<ModelSettings>,
}

/// 端点能力探测结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub json_schema: bool,
    pub json_object: bool,
    pub streaming: bool,
    pub list_models: bool,
}

/// 连通性测试结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Capabilities>,
    /// 毫秒时间戳。
    pub at: i64,
}

/// 供应商（不含密钥）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub protocol: Protocol,
    /// 密钥环条目名。
    #[serde(default)]
    pub secret_ref: String,
    #[serde(default)]
    pub models: Vec<ModelEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_probe: Option<ProbeResult>,
}

/// `GET /models` 返回的一项。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<i64>,
}

impl Provider {
    /// 补全界面不该关心、但后端必须有值的字段。
    ///
    /// `secretRef` 由前端生成；万一给空了就补一个稳定值，
    /// 否则同一个供应商会在凭据管理器里留下好几个孤儿条目。
    pub fn normalize(&mut self) {
        if self.secret_ref.trim().is_empty() {
            self.secret_ref = format!("provider:{}", self.id);
        }
        self.base_url = self.base_url.trim().trim_end_matches('/').to_string();
        self.name = self.name.trim().to_string();
    }
}

fn path() -> Result<std::path::PathBuf> {
    let dir = crate::logging::config_dir().ok_or_else(|| {
        CommandError::no_config_dir("定位不到配置目录（%APPDATA%），无法读写供应商配置。")
    })?;
    Ok(dir.join("providers.json"))
}

/// 磁盘格式的版本号。与原程序一致。
const SCHEMA_VERSION: u32 = 1;

/// 写盘用的信封：`{"schema_version":1,"providers":[…]}`。
///
/// 原程序的 `providers.json` 就是这个形状，**不是裸数组**。用户已有的文件里存着
/// 他的供应商（baseUrl、模型列表、secretRef），读错形状等于把配置整个吃掉。
#[derive(Debug, Serialize)]
struct ProvidersFile {
    schema_version: u32,
    providers: Vec<Provider>,
}

/// 读盘时信封与裸数组都认。
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ProvidersFileRead {
    Envelope {
        #[allow(dead_code)]
        schema_version: u32,
        providers: Vec<Provider>,
    },
    Bare(Vec<Provider>),
}

/// 读全部供应商。
pub fn load_all() -> Result<Vec<Provider>> {
    let list = match persist::read_json::<ProvidersFileRead>(&path()?, "供应商配置")? {
        Some(ProvidersFileRead::Envelope { providers, .. }) => providers,
        Some(ProvidersFileRead::Bare(providers)) => providers,
        None => Vec::new(),
    };
    Ok(list)
}

/// 覆盖写。
pub fn save_all(list: &[Provider]) -> Result<()> {
    let file = ProvidersFile {
        schema_version: SCHEMA_VERSION,
        providers: list.to_vec(),
    };
    persist::write_json(&path()?, &file, "供应商配置")
}

/// 按 id 找。找不到时给出「可能已被删除」这种能解释现象的文案。
pub fn find(id: &str) -> Result<Provider> {
    load_all()?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| CommandError::not_found(format!("找不到供应商 {id}，它可能已经被删除。")))
}

/// 新增或更新，返回写入后的对象。
pub fn upsert(mut provider: Provider) -> Result<Provider> {
    provider.normalize();
    let mut list = load_all()?;
    match list.iter_mut().find(|p| p.id == provider.id) {
        Some(slot) => *slot = provider.clone(),
        None => list.push(provider.clone()),
    }
    save_all(&list)?;
    Ok(provider)
}

/// 删除一个。返回它的 `secretRef`（调用方据此清掉密钥）。
pub fn remove(id: &str) -> Result<Option<String>> {
    let mut list = load_all()?;
    let before = list.len();
    let mut secret_ref = None;
    list.retain(|p| {
        if p.id == id {
            secret_ref = Some(p.secret_ref.clone());
            false
        } else {
            true
        }
    });
    if list.len() == before {
        return Ok(None);
    }
    save_all(&list)?;
    Ok(secret_ref)
}

/// 批量删除。返回实际删掉的数量与被删对象的 `secretRef`。
pub fn remove_many(ids: &[String]) -> Result<(usize, Vec<String>)> {
    let mut list = load_all()?;
    let before = list.len();
    let mut refs = Vec::new();
    list.retain(|p| {
        if ids.iter().any(|id| id == &p.id) {
            refs.push(p.secret_ref.clone());
            false
        } else {
            true
        }
    });
    let removed = before - list.len();
    if removed > 0 {
        save_all(&list)?;
    }
    Ok((removed, refs))
}

/// 把一次探测结果记进配置。
pub fn record_probe(id: &str, probe: ProbeResult) -> Result<()> {
    let mut list = load_all()?;
    if let Some(slot) = list.iter_mut().find(|p| p.id == id) {
        slot.last_probe = Some(probe);
        save_all(&list)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str) -> Provider {
        Provider {
            id: id.to_string(),
            name: "  测试端点  ".to_string(),
            base_url: "https://example.com/v1/".to_string(),
            protocol: Protocol::ChatCompletions,
            secret_ref: String::new(),
            models: Vec::new(),
            last_probe: None,
        }
    }

    #[test]
    fn normalize_fills_secret_ref_and_trims() {
        let mut p = provider("p_1");
        p.normalize();
        assert_eq!(p.secret_ref, "provider:p_1");
        assert_eq!(p.name, "测试端点");
        // 尾部的 `/` 必须去掉，否则会拼出 `//chat/completions`。
        assert_eq!(p.base_url, "https://example.com/v1");
    }

    #[test]
    fn normalize_keeps_an_explicit_secret_ref() {
        let mut p = provider("p_1");
        p.secret_ref = "custom:ref".to_string();
        p.normalize();
        assert_eq!(p.secret_ref, "custom:ref");
    }

    #[test]
    fn protocol_round_trips_in_snake_case() {
        let json = serde_json::to_string(&Protocol::ChatCompletions).unwrap();
        assert_eq!(json, "\"chat_completions\"");
        let json = serde_json::to_string(&Protocol::Responses).unwrap();
        assert_eq!(json, "\"responses\"");
    }

    #[test]
    fn provider_serializes_with_camel_case_keys() {
        let p = provider("p_1");
        let json = serde_json::to_value(&p).unwrap();
        assert!(json.get("baseUrl").is_some());
        assert!(json.get("secretRef").is_some());
        assert!(json.get("base_url").is_none());
    }

    #[test]
    fn model_entry_display_name_is_camel_case() {
        let m = ModelEntry {
            id: "gpt-4o".to_string(),
            display_name: Some("GPT-4o".to_string()),
            settings: None,
        };
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["displayName"], "GPT-4o");
    }

    #[test]
    fn model_settings_serialize_as_camel_case_and_drop_empty_keys() {
        let m = ModelEntry {
            id: "o3".to_string(),
            display_name: None,
            settings: Some(ModelSettings {
                temperature: Some(0.7),
                reasoning_effort: Some("high".to_string()),
                structured_output: None,
                multimodal: Some(false),
            }),
        };
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["settings"]["temperature"], 0.7);
        // 前端类型里是 `reasoningEffort`，不是 `reasoning_effort`
        assert_eq!(json["settings"]["reasoningEffort"], "high");
        assert_eq!(json["settings"]["multimodal"], false);
        // 没设过的键整个消失，而不是留一个 null
        assert!(json["settings"].get("structuredOutput").is_none());
        assert!(json.get("displayName").is_none());
    }

    /// 老配置文件（模型条目里没有 `settings`）必须照样读得进来 ——
    /// 这份文件是用户攒下来的，读不出来等于把他的供应商全弄丢了。
    #[test]
    fn a_model_entry_without_settings_still_deserializes() {
        let old = r#"{"id":"gpt-4o","displayName":"GPT-4o"}"#;
        let m: ModelEntry = serde_json::from_str(old).unwrap();
        assert_eq!(m.id, "gpt-4o");
        assert!(m.settings.is_none());
    }
}
