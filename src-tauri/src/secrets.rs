//! 密钥存取 —— 全部走 Windows 凭据管理器。
//!
//! ⚠ 密钥**只**在这里出现：不进配置文件、不进前端状态、不进日志。
//! 配置里存的是 `secretRef`（一个条目名），拿不到密钥本身。

use keyring::Entry;

use crate::error::{CommandError, Result};

/// 凭据管理器里的服务名。
const SERVICE: &str = "com.dsh.resume-embellishment";

fn entry(secret_ref: &str) -> Result<Entry> {
    Entry::new(SERVICE, secret_ref).map_err(|e| match e {
        keyring::Error::NoDefaultStore => CommandError::keyring_unavailable(
            "系统密钥环不可用，无法保存密钥。\n\
             你仍然可以在每次生成时临时粘贴 API Key，只是重启后需要重新输入。",
        ),
        other => CommandError::keyring(format!("打开密钥环条目失败：{other}")),
    })
}

/// 密钥环是否可用。前端启动时调一次，不可用就直接禁用「保存密钥」。
pub fn status() -> Result<()> {
    match Entry::store_status() {
        Ok(()) => Ok(()),
        Err(e) => Err(CommandError::keyring_unavailable(format!(
            "系统密钥环不可用：{e}\n\
             保存 API Key 需要 Windows 凭据管理器。"
        ))),
    }
}

/// 写入（覆盖）密钥。
pub fn store(secret_ref: &str, api_key: &str) -> Result<()> {
    entry(secret_ref)?
        .set_password(api_key)
        .map_err(|e| CommandError::keyring(format!("保存密钥失败：{e}")))
}

/// 读密钥。**没配过返回 `Ok(None)`，不是错误** —— 那是一个正常状态。
pub fn load(secret_ref: &str) -> Result<Option<String>> {
    match entry(secret_ref)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(CommandError::keyring(format!("读取密钥失败：{e}"))),
    }
}

/// 删除密钥。
///
/// 本来就没有也算成功：调用方要的是「删掉之后它不在了」，
/// 而不是「这次调用恰好删掉了一个东西」。
pub fn delete(secret_ref: &str) -> Result<()> {
    match entry(secret_ref)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(CommandError::keyring(format!("删除密钥失败：{e}"))),
    }
}

/// 是否已配置密钥。
pub fn has(secret_ref: &str) -> bool {
    match load(secret_ref) {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(e) => {
            crate::logging::log_line(&format!("检查密钥时出错（按未配置处理）：{e}"));
            false
        }
    }
}

/// 取密钥，取不到就给出可执行的提示。
pub fn require(secret_ref: &str) -> Result<String> {
    match load(secret_ref)? {
        Some(key) if !key.trim().is_empty() => Ok(key),
        _ => Err(CommandError::no_key(
            "这个供应商还没有配置 API Key。\n\
             在「模型供应商」里填一次即可，密钥会存进 Windows 凭据管理器。",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_key_is_an_error_with_actionable_text() {
        // 用一个绝不可能存在的条目名，避免碰到开发者本机真实保存的密钥。
        let e = require("__re_test_definitely_absent__").unwrap_err();
        assert_eq!(e.kind, "no_key");
        assert!(e.message.contains("API Key"));
    }

    #[test]
    fn has_is_false_for_an_absent_entry() {
        assert!(!has("__re_test_definitely_absent__"));
    }

    #[test]
    fn deleting_an_absent_entry_succeeds() {
        // 「删掉」的语义是幂等的。
        delete("__re_test_definitely_absent__").expect("deleting a missing key must not fail");
    }
}
