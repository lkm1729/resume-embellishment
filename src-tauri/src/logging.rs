//! 崩溃可观测性 —— 让「闪退」留下证据。
//!
//! 发布版是 `windows_subsystem = "windows"` + `[profile.release] strip = true`：
//! 没有控制台，panic 文本无处可去，用户看到的只是窗口闪一下就没了。
//! 这正是「排查几个小时也定位不到」的真正原因 —— 不是 bug 难，
//! 而是**没有反馈回路**。先修反馈回路，再谈修 bug。
//!
//! 这里做三件事：
//!   1. panic hook 把 panic 连同位置写进日志，并在 exe 旁边留一份人可读的提示文件；
//!   2. 启动 / 就绪 / 正常退出各写一个标记，下次启动据此判断上次是否善终；
//!   3. 日志优先落在 exe 同目录（用户最容易找到），写不进去才退回 `%APPDATA%`。
//!
//! ⚠ `previous_run_crashed()` 必须在 `install()` **之前**调用：
//! `install()` 会写入本次的启动标记，之后再判断就恒为「上次崩溃」。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// 一次启动的开始。
pub const START_MARK: &str = "===== 启动";
/// webview 建好、窗口真正显示出来。
pub const READY_MARK: &str = "启动完成";
/// 正常退出（`run()` 返回，或单实例守卫主动让路）。
pub const EXIT_MARK: &str = "正常退出";
/// panic。
pub const PANIC_MARK: &str = "!!! 崩溃 !!!";

const APP_DIR_NAME: &str = "com.dsh.resume-embellishment";
const LOG_NAME: &str = "crash.log";
const PREV_LOG_NAME: &str = "crash.prev.log";
/// 出事时留在 exe 旁边的那份 —— 用户最可能看到的就是它。
const NOTICE_NAME: &str = "启动失败-请看这里.txt";
/// 超过这个大小就把当前日志轮转成 `crash.prev.log`。
const MAX_LOG_BYTES: u64 = 256 * 1024;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// exe 所在目录。
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

/// `%APPDATA%\com.dsh.resume-embellishment` —— 我们自己的配置文件放这里。
pub fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(APP_DIR_NAME))
}

/// `%LOCALAPPDATA%\com.dsh.resume-embellishment` —— WebView2 的用户数据目录在这里。
///
/// 与 `config_dir()` 分开：漫游配置（历史、供应商）跟着用户走，
/// 而 WebView2 的几百兆缓存不该跟着漫游。
pub fn local_app_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join(APP_DIR_NAME))
}

/// 日志文件路径。
///
/// 用 `OnceLock` 缓存：探测结果必须稳定，否则同一进程里两次调用可能
/// 落到不同文件，「上次是否崩溃」就会读到半份日志。
pub fn log_path() -> &'static Path {
    LOG_PATH.get_or_init(|| {
        // 先试 exe 同目录：绿色版 / 免安装场景下这是用户唯一找得到的位置。
        if let Some(dir) = exe_dir() {
            let candidate = dir.join(LOG_NAME);
            if OpenOptions::new()
                .create(true)
                .append(true)
                .open(&candidate)
                .is_ok()
            {
                return candidate;
            }
        }
        if let Some(dir) = config_dir() {
            let _ = fs::create_dir_all(&dir);
            return dir.join(LOG_NAME);
        }
        PathBuf::from(LOG_NAME)
    })
}

/// 从日志文本判断「上一次运行是否没善终」。
///
/// 判据刻意**不用**「最后一个 READY 之后什么都没有」——正常关窗同样满足，
/// 于是每次正常关闭都会被当成崩溃、白挪一遍用户数据目录。
/// 所以正常退出有一个独立标记。
pub fn crashed_from_log(text: &str) -> bool {
    match (text.rfind(START_MARK), text.rfind(EXIT_MARK)) {
        (Some(start), Some(exit)) => exit < start,
        (Some(_), None) => true,
        _ => false,
    }
}

/// 上次运行是否崩溃。**必须在 `install()` 之前调用。**
pub fn previous_run_crashed() -> bool {
    match fs::read_to_string(log_path()) {
        Ok(text) => crashed_from_log(&text),
        Err(_) => false,
    }
}

/// 写一行带时间戳的日志。
pub fn log_line(msg: &str) {
    log_raw(&format!("[{}] {}\n", stamp_now(), msg));
}

fn log_raw(text: &str) {
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = f.write_all(text.as_bytes());
        let _ = f.flush();
    }
}

/// 安装 panic hook，并写下本次启动标记。
pub fn install() {
    trim_if_huge();
    log_line(&format!("{START_MARK} v{}", env!("CARGO_PKG_VERSION")));

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let detail = format!("{info}");
        log_raw(&format!("{PANIC_MARK}\n{detail}\n"));
        write_notice(&detail);
        previous(info);
    }));
}

/// webview 已经建好，窗口真的显示出来了。
pub fn mark_ready() {
    log_line(READY_MARK);
}

/// 正常退出。**单实例守卫让路时也要写**，否则「双击两次」会让
/// 下一次启动误判成崩溃、白挪一遍用户数据目录。
pub fn mark_clean_exit() {
    log_line(EXIT_MARK);
}

fn notice_path() -> Option<PathBuf> {
    exe_dir().map(|d| d.join(NOTICE_NAME))
}

/// 在 exe 旁边留一份人可读的失败说明。
fn write_notice(detail: &str) {
    let Some(path) = notice_path() else { return };
    let text = format!(
        "简历与求职信美化 —— 启动失败\r\n\
         \r\n\
         程序在启动过程中崩溃了。把这条提示留在 exe 旁边，是为了让你能把它发出来。\r\n\
         \r\n\
         ── 崩溃信息 ─────────────────────────────────────\r\n\
         {detail}\r\n\
         \r\n\
         ── 怎么做 ───────────────────────────────────────\r\n\
         1. 先关掉已经打开的「简历与求职信美化」窗口（重复启动会争用同一个数据目录）；\r\n\
         2. 若仍然打不开，双击同目录下的「修复-启动失败.cmd」；\r\n\
         3. 完整日志在：{}\r\n\
         \r\n\
         把这份文件连同 crash.log 一起发出来即可定位。\r\n",
        log_path().display()
    );
    let _ = fs::write(path, text);
}

/// 日志超过上限就轮转，避免无限增长。
fn trim_if_huge() {
    let path = log_path();
    let Ok(meta) = fs::metadata(path) else { return };
    if meta.len() <= MAX_LOG_BYTES {
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = fs::rename(path, dir.join(PREV_LOG_NAME));
    }
}

/// `YYYYMMDDHHMMSS`，用于备份目录名。
pub fn compact_stamp() -> String {
    let (y, mo, d, h, mi, s) = now_parts();
    format!("{y:04}{mo:02}{d:02}{h:02}{mi:02}{s:02}")
}

/// `YYYY-MM-DD HH:MM:SS`（**UTC**）。
fn stamp_now() -> String {
    let (y, mo, d, h, mi, s) = now_parts();
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}Z")
}

fn now_parts() -> (i64, u32, u32, u32, u32, u32) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, mo, d) = civil_from_days(days);
    (
        y,
        mo,
        d,
        (rem / 3600) as u32,
        ((rem % 3600) / 60) as u32,
        (rem % 60) as u32,
    )
}

/// Howard Hinnant 的 `civil_from_days`：把「1970-01-01 起的天数」变成年月日。
///
/// 手写而不引 chrono —— 只为一行时间戳不值得加一个依赖。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_run_is_not_a_crash() {
        let log = format!("{START_MARK} v0.1.0\n{READY_MARK}\n{EXIT_MARK}\n");
        assert!(!crashed_from_log(&log));
    }

    #[test]
    fn start_without_exit_is_a_crash() {
        let log = format!("{START_MARK} v0.1.0\n{READY_MARK}\n");
        assert!(crashed_from_log(&log));
    }

    #[test]
    fn crash_before_ready_is_a_crash() {
        let log = format!("{START_MARK} v0.1.0\n{PANIC_MARK}\nboom\n");
        assert!(crashed_from_log(&log));
    }

    #[test]
    fn crash_then_successful_run_is_not_a_crash() {
        let log = format!(
            "{START_MARK} v0.1.0\n{PANIC_MARK}\nboom\n\
             {START_MARK} v0.1.0\n{READY_MARK}\n{EXIT_MARK}\n"
        );
        assert!(!crashed_from_log(&log));
    }

    #[test]
    fn empty_or_unrelated_log_is_not_a_crash() {
        assert!(!crashed_from_log(""));
        assert!(!crashed_from_log("随便什么内容\n"));
    }

    #[test]
    fn rotated_log_without_start_mark_is_not_a_crash() {
        // 轮转后的旧日志以 EXIT_MARK 收尾，但开头被截掉了。
        // 宁可漏报一次，也不要每次启动都去挪用户的数据目录。
        assert!(!crashed_from_log(&format!("{EXIT_MARK}\n")));
    }

    #[test]
    fn timestamp_is_sortable() {
        let a = stamp_now();
        let b = stamp_now();
        assert!(a <= b);
        assert_eq!(a.len(), 20, "YYYY-MM-DD HH:MM:SSZ");
        assert!(a.ends_with('Z'));
    }

    #[test]
    fn civil_converts_known_instants() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2024-02-29 —— 闰日，最容易写错的一天。
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }

    #[test]
    fn compact_stamp_is_fourteen_digits() {
        let s = compact_stamp();
        assert_eq!(s.len(), 14);
        assert!(s.chars().all(|c| c.is_ascii_digit()));
    }
}
