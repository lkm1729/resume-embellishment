//! 生成历史 —— 回滚全靠它。
//!
//! 每条记录里是**完整快照**（`designSpec` + `contentSnapshot`），而不是差量。
//! 差量省磁盘，但回滚时要重放整条链；一条坏记录就能毁掉其后全部历史。
//! 按每条几十 KB、上限一百条算，这点磁盘换的是「任何一条都能独立回滚」。

use serde::{Deserialize, Serialize};

use crate::error::{CommandError, Result};
use crate::persist;

/// 上限。超出时丢最旧的，`add` 会把丢掉的条数返回给前端提示用户。
pub const MAX_ENTRIES: usize = 100;

/// 一条历史记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    /// `resume` 或 `cover-letter`。
    pub doc_type: String,
    /// 毫秒时间戳。
    pub created_at: i64,
    pub provider_name: String,
    pub model_name: String,
    pub protocol: String,
    /// 设计规格。**原样透传**：Rust 侧不解释它的结构，
    /// 否则前端的 spec 一变这里就要跟着改，而它并不需要理解。
    pub design_spec: serde_json::Value,
    /// 完整内容快照。
    pub content_snapshot: serde_json::Value,
    pub content_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

fn path() -> Result<std::path::PathBuf> {
    let dir = crate::logging::config_dir().ok_or_else(|| {
        CommandError::no_config_dir("定位不到配置目录（%APPDATA%），无法读写历史记录。")
    })?;
    Ok(dir.join("history.json"))
}

/// 磁盘格式的版本号。与原程序一致；改结构时必须同步升版本。
const SCHEMA_VERSION: u32 = 1;

/// 写盘用的信封。
///
/// 原程序的 `history.json` 长这样：`{"schema_version":1,"entries":[]}` ——
/// **不是裸数组**。先前按裸数组读，用户已有的文件就被判成「历史记录损坏」
/// （`invalid type: map, expected a sequence`），所以这里必须原样兼容。
#[derive(Debug, Serialize)]
struct HistoryFile {
    schema_version: u32,
    entries: Vec<HistoryEntry>,
}

/// 读盘时两种形状都认：信封优先，也接受更早的裸数组。
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum HistoryFileRead {
    Envelope {
        #[allow(dead_code)]
        schema_version: u32,
        entries: Vec<HistoryEntry>,
    },
    Bare(Vec<HistoryEntry>),
}

/// 读全部，**已按时间倒序**。
pub fn load_all() -> Result<Vec<HistoryEntry>> {
    let mut list = match persist::read_json::<HistoryFileRead>(&path()?, "历史记录")? {
        Some(HistoryFileRead::Envelope { entries, .. }) => entries,
        Some(HistoryFileRead::Bare(entries)) => entries,
        None => Vec::new(),
    };
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(list)
}

fn save_all(list: &[HistoryEntry]) -> Result<()> {
    let file = HistoryFile {
        schema_version: SCHEMA_VERSION,
        entries: list.to_vec(),
    };
    persist::write_json(&path()?, &file, "历史记录")
}

/// 新增一条，返回**因超出上限被丢弃的条数**。
pub fn add(entry: HistoryEntry) -> Result<usize> {
    let mut list = load_all()?;
    // 同 id 直接替换：重复添加不该在列表里出现两行一模一样的记录。
    list.retain(|e| e.id != entry.id);
    list.push(entry);
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    let dropped = list.len().saturating_sub(MAX_ENTRIES);
    if dropped > 0 {
        list.truncate(MAX_ENTRIES);
    }
    save_all(&list)?;
    Ok(dropped)
}

pub fn get(id: &str) -> Result<HistoryEntry> {
    load_all()?.into_iter().find(|e| e.id == id).ok_or_else(|| {
        CommandError::not_found(format!("找不到这条记录（{id}），它可能已经被删除。"))
    })
}

pub fn delete(id: &str) -> Result<()> {
    let mut list = load_all()?;
    let before = list.len();
    list.retain(|e| e.id != id);
    if list.len() != before {
        save_all(&list)?;
    }
    Ok(())
}

/// 批量删除，返回实际删掉的数量。
pub fn delete_many(ids: &[String]) -> Result<usize> {
    let mut list = load_all()?;
    let before = list.len();
    list.retain(|e| !ids.iter().any(|id| id == &e.id));
    let removed = before - list.len();
    if removed > 0 {
        save_all(&list)?;
    }
    Ok(removed)
}

/// 清空，返回清掉的条数。
pub fn clear() -> Result<usize> {
    let list = load_all()?;
    let n = list.len();
    if n > 0 {
        save_all(&[])?;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, at: i64) -> HistoryEntry {
        HistoryEntry {
            id: id.to_string(),
            doc_type: "resume".to_string(),
            created_at: at,
            provider_name: "本地".to_string(),
            model_name: "m".to_string(),
            protocol: "chat_completions".to_string(),
            design_spec: json!({ "title": "亮色" }),
            content_snapshot: json!([{ "id": "u1", "text": "张伟" }]),
            content_hash: "abc".to_string(),
            note: None,
        }
    }

    #[test]
    fn entry_round_trips_through_json_with_camel_case() {
        let e = entry("h_1", 1);
        let text = serde_json::to_string(&e).unwrap();
        assert!(text.contains("\"docType\""));
        assert!(text.contains("\"contentSnapshot\""));
        assert!(text.contains("\"designSpec\""));
        let back: HistoryEntry = serde_json::from_str(&text).unwrap();
        assert_eq!(back.id, "h_1");
        assert_eq!(back.content_hash, "abc");
    }

    #[test]
    fn design_spec_is_passed_through_untouched() {
        // Rust 侧不该「理解」spec —— 它只是搬运工。
        let e = entry("h_2", 2);
        let text = serde_json::to_string(&e).unwrap();
        let back: HistoryEntry = serde_json::from_str(&text).unwrap();
        assert_eq!(back.design_spec, e.design_spec);
    }

    #[test]
    fn note_is_optional_and_omitted_when_absent() {
        let e = entry("h_3", 3);
        let text = serde_json::to_string(&e).unwrap();
        assert!(!text.contains("note"));
        // 但读的时候缺字段不能报错。
        let back: HistoryEntry = serde_json::from_str(&text).unwrap();
        assert!(back.note.is_none());
    }

    #[test]
    fn max_entries_is_a_positive_cap() {
        assert!(MAX_ENTRIES > 0);
    }
}
