//! 后端统一错误结构。
//!
//! 前端 `src/core/llm/types.ts` 里的 `CommandError { kind, message }` 就是它。
//! `message` 是面向用户的中文说明（可能多行，可能含供应商原始报错），
//! `kind` 让前端能做分支而不必去解析文案。
//!
//! 前端只读 `kind` 与 `message` 两个字段，所以这里保持扁平：
//! 多一层 `data` 只会让两边的类型定义各自长出一棵没人用的树。

use serde::Serialize;

/// 给前端看的错误。
#[derive(Debug, Clone, Serialize)]
pub struct CommandError {
    /// 机器可读的分类。
    pub kind: String,
    /// 面向用户的说明。
    pub message: String,
}

/// 本 crate 内部通用的 Result。
pub type Result<T> = std::result::Result<T, CommandError>;

impl CommandError {
    pub fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
        }
    }

    /// 参数不合法。
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid", message)
    }

    /// 找不到对象（记录、供应商……）。
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message)
    }

    /// 配置文件损坏。**不要**静默重置 —— 用户的历史很可能还能救回来。
    pub fn corrupt_config(message: impl Into<String>) -> Self {
        Self::new("corrupt_config", message)
    }

    /// 文件读写失败。
    pub fn io(message: impl Into<String>) -> Self {
        Self::new("io", message)
    }

    /// 定位不到配置目录。
    pub fn no_config_dir(message: impl Into<String>) -> Self {
        Self::new("no_config_dir", message)
    }

    /// 该供应商还没配密钥。
    pub fn no_key(message: impl Into<String>) -> Self {
        Self::new("no_key", message)
    }

    /// 系统密钥环不可用。
    pub fn keyring_unavailable(message: impl Into<String>) -> Self {
        Self::new("keyring_unavailable", message)
    }

    /// 密钥环操作失败（可用，但这一步失败）。
    pub fn keyring(message: impl Into<String>) -> Self {
        Self::new("keyring", message)
    }

    /// 供应商 / 模型调用失败。
    pub fn llm(message: impl Into<String>) -> Self {
        Self::new("llm", message)
    }

    /// 导出失败。
    pub fn export(message: impl Into<String>) -> Self {
        Self::new("export", message)
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.kind, self.message)
    }
}

impl std::error::Error for CommandError {}

impl From<std::io::Error> for CommandError {
    fn from(e: std::io::Error) -> Self {
        Self::io(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_the_shape_the_frontend_expects() {
        let e = CommandError::no_key("还没配置密钥");
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "no_key");
        assert_eq!(json["message"], "还没配置密钥");
        // 前端只用这两个字段，多出来的字段会被忽略，但多一个都是负担。
        assert_eq!(json.as_object().unwrap().len(), 2);
    }

    #[test]
    fn io_errors_become_io_kind() {
        let e: CommandError = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "拒绝访问").into();
        assert_eq!(e.kind, "io");
        assert!(e.message.contains("拒绝访问"));
    }
}
