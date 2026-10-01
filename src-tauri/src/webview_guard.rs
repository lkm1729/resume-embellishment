//! 启动守卫。
//!
//! 用户报的现象是「点进去就闪退」。机制是：
//! Tauri 先建窗口、再建 webview，而 WebView2 在**同一个用户数据目录
//! 正被占用**时会以 `ERROR_BUSY` 之类的 HRESULT 创建失败，
//! 于是 `setup()` 拿到 Err 直接 panic —— 但窗口已经画出来了，
//! 所以看起来正是「弹出画面就闪退」。
//!
//! 两道防线：
//!   1. **单实例守卫**：第二次双击直接给一句人话，而不是让 WebView2 去报
//!      一个谁也看不懂的 HRESULT；
//!   2. **数据目录自愈**：上次没善终就把 `EBWebView` 改名备份，下次从干净
//!      目录起来。备份而不是删除 —— 用户的登录态和缓存都还在里面。

use std::fs::{self, File, OpenOptions};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static INSTANCE_LOCK: OnceLock<File> = OnceLock::new();

/// WebView2 的用户数据目录名，Tauri 默认就用这个名字。
const PROFILE_DIR: &str = "EBWebView";
/// 最多保留两份备份，再多就是在拿用户的磁盘换安心。
const MAX_BACKUPS: usize = 2;

/// 抢单实例锁。返回 `false` 表示**已经有一个实例在跑**。
///
/// 用 `share_mode(0)` 打开一个普通文件：Windows 不允许第二个进程同时打开它。
/// 这比「枚举同名进程」可靠 —— 后者在用户重命名过 exe 之后就失效了。
pub fn claim_single_instance() -> bool {
    let Some(dir) = crate::logging::config_dir() else {
        return true; // 定位不到配置目录就没法判定，宁可放行也不要拦住用户
    };
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("app.lock");
    let existed = path.exists();

    match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .share_mode(0)
        .open(&path)
    {
        Ok(file) => {
            // 句柄必须活到进程结束 —— 一旦被 drop，锁就没了。
            if let Err(file) = INSTANCE_LOCK.set(file) {
                std::mem::forget(file);
            }
            true
        }
        // 锁文件在、却打不开 → 另一个实例正握着它。
        Err(_) if existed => false,
        // 锁文件根本不存在也建不出来（权限 / 磁盘）→ 那是另一个问题，
        // 不该用一句假的「已在运行」把它盖过去。
        Err(_) => true,
    }
}

/// 系统级提示框。
pub fn show_message(title: &str, text: &str) {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONINFORMATION, MB_OK};
    let text = HSTRING::from(text);
    let caption = HSTRING::from(title);
    unsafe {
        MessageBoxW(None, &text, &caption, MB_OK | MB_ICONINFORMATION);
    }
}

/// 准备 WebView2 用户数据目录。
///
/// `crashed_last_time` 由调用方传入，而不是在这里自己读日志：
/// 这时 `logging::install()` 已经写过本次的启动标记，再判断就恒为真。
///
/// 返回 `Some(fresh)` 表示**换了一个全新的目录**（并通过环境变量告诉 WebView2），
/// 返回 `None` 表示沿用原目录。
pub fn prepare_profile(crashed_last_time: bool) -> Option<PathBuf> {
    if !crashed_last_time {
        return None;
    }
    let base = webview_profile_dir()?;
    if !base.exists() {
        return None; // 还没建过目录，没什么可自愈的
    }

    let backup = sibling(&base, &format!("{PROFILE_DIR}.crashed-{}", crate::logging::compact_stamp()));
    match fs::rename(&base, &backup) {
        Ok(()) => {
            crate::logging::log_line(&format!(
                "上次未正常退出：WebView2 数据目录已备份为 {}",
                backup.display()
            ));
            prune_old_backups(&base);
            return None; // 原路径现在是空的，WebView2 会自己重建
        }
        Err(e) => {
            // 挪不动 = 还有 WebView2 子进程占着它。我们无权、也不该去杀
            // 别的进程（同机上还有别的 WebView2 应用），于是换一个全新目录。
            crate::logging::log_line(&format!(
                "WebView2 数据目录挪不动（{e}），本次改用全新目录"
            ));
        }
    }

    let fresh = sibling(
        &base,
        &format!("{PROFILE_DIR}.recovered-{}", crate::logging::compact_stamp()),
    );
    if fs::create_dir_all(&fresh).is_ok() {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &fresh);
        return Some(fresh);
    }
    crate::logging::log_line("连新建 WebView2 数据目录都失败了，只能按原样启动");
    None
}

/// `%LOCALAPPDATA%\com.dsh.resume-embellishment\EBWebView`
fn webview_profile_dir() -> Option<PathBuf> {
    crate::logging::local_app_dir().map(|d| d.join(PROFILE_DIR))
}

fn sibling(path: &Path, name: &str) -> PathBuf {
    path.parent()
        .map(|p| p.join(name))
        .unwrap_or_else(|| PathBuf::from(name))
}

/// 只保留最近 `MAX_BACKUPS` 份备份。
fn prune_old_backups(base: &Path) {
    let Some(dir) = base.parent() else { return };
    let Ok(entries) = fs::read_dir(dir) else { return };
    let prefix = format!("{PROFILE_DIR}.");
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
        .filter(|n| n.starts_with(&prefix))
        .collect();
    // 名字里带 compact_stamp，按字典序倒排即按时间倒排。
    names.sort();
    names.reverse();
    for n in names.into_iter().skip(MAX_BACKUPS) {
        let _ = fs::remove_dir_all(dir.join(n));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sibling_keeps_the_same_directory() {
        let base = PathBuf::from(r"C:\x\y\EBWebView");
        assert_eq!(
            sibling(&base, "EBWebView.crashed-1"),
            PathBuf::from(r"C:\x\y\EBWebView.crashed-1")
        );
    }

    #[test]
    fn sibling_without_parent_degrades_to_a_bare_name() {
        assert_eq!(
            sibling(Path::new("EBWebView"), "EBWebView.bak"),
            PathBuf::from("EBWebView.bak")
        );
    }

    #[test]
    fn profile_dir_sits_under_local_app_data() {
        let dir = webview_profile_dir().expect("local app data should exist on a dev box");
        assert!(dir.ends_with("EBWebView"));
        assert!(dir.to_string_lossy().contains("com.dsh.resume-embellishment"));
    }
}
