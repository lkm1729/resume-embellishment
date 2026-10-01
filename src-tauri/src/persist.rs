//! 配置文件的读写。
//!
//! 两条规矩：
//!   1. **文件不存在 = 空**，不是错误。用户第一次打开程序时本来就没有配置。
//!   2. **原子写**：先写同目录的 `.tmp` 再改名。直接覆盖原文件时，
//!      一次断电或一次崩溃就能把用户积累的历史全部清零 ——
//!      那比"缺少这个功能"糟得多。

use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{CommandError, Result};

/// 读一个 JSON 文件。文件不存在或内容为空时返回 `None`。
///
/// `what` 是给用户看的名字（"供应商配置"、"历史记录"），会出现在错误文案里。
pub fn read_json<T: DeserializeOwned>(path: &Path, what: &str) -> Result<Option<T>> {
    match std::fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(CommandError::io(format!(
            "读取{what}失败（{}）：{e}",
            path.display()
        ))),
        Ok(text) if text.trim().is_empty() => Ok(None),
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| {
            // **不静默重建**：用户的历史很可能还能人工救回来，
            // 直接清空等于替用户做了销毁决定。
            CommandError::corrupt_config(format!(
                "{what}损坏（{}）：{e}\n\
                 把这个文件改名备份后重启，程序会重建一份空的。",
                path.display()
            ))
        }),
    }
}

/// 原子地写一个 JSON 文件。
// `?Sized` 是必需的：保存历史时会直接传 `&[HistoryEntry]`。
pub fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T, what: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| {
                CommandError::io(format!("创建配置目录失败（{}）：{e}", dir.display()))
            })?;
        }
    }

    let text = serde_json::to_string_pretty(value)
        .map_err(|e| CommandError::io(format!("序列化{what}失败：{e}")))?;

    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text.as_bytes())
        .map_err(|e| CommandError::io(format!("写入{what}失败（{}）：{e}", tmp.display())))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        CommandError::io(format!("替换{what}失败（{}）：{e}", path.display()))
    })?;
    Ok(())
}
