//! PDF 导出。
//!
//! WebView2 的 `PrintToPdf` 打的是**整个 webview**。
//! 所以"把界面切成导出视图、打完再切回来"是前端的职责
//! （见 `src/core/export/export.ts` 的文件头注释），
//! 这一层只负责把当前页面打印成 PDF。
//!
//! 三个容易踩空的地方，都在下面各自的位置写清楚了：
//!
//! 1. **绝不在主线程上等回调。** 完成回调是 PostMessage 到主线程消息队列的，
//!    而 `with_webview` 的闭包恰恰就跑在主线程上 —— 在里面等（哪怕是
//!    `wait_with_pump` 这种"一边抽消息一边等"）会把消息泵堵死，回调永远派发
//!    不出来，命令就再也回不去了（实测：日志停在"已发起，开始 wait_with_pump"，
//!    连打印都没真正开始）。正确姿势是闭包**只发起**，等待放在调用线程上做
//!    `recv_timeout`，让 Tauri 正常的主循环去派发回调。
//! 2. **纸张尺寸要跟前端的 A4 常量严格一致**，否则预览里算出来的页数
//!    和导出的页数对不上。
//! 3. **界面底色与文档底色是两件事**。应用可能处于深色主题，
//!    `html/body/#root` 是深色的；但正文自己有自己的配色
//!    （`DesignSpec.theme.palette.bg`），那是设计的一部分，不能动。

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::time::Duration;

use serde::Serialize;
use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2_7, ICoreWebView2Environment6, ICoreWebView2PrintSettings,
    COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
};
use webview2_com::{ExecuteScriptCompletedHandler, PrintToPdfCompletedHandler};
use windows::core::{HSTRING, Interface};

use crate::error::{CommandError, Result};
use crate::logging::log_line;

/// A4 @96dpi，与前端 `A4_WIDTH_PX = 794` / `A4_HEIGHT_PX = 1123` 严格一致。
///
/// 不用标准的 8.27 × 11.69 英寸：那比 1123px 矮约 0.005 英寸，
/// 会让最后一行溢出到多出来的一页上 —— 用户看到的就是"凭空多出一张空白页"。
const PAGE_W_IN: f64 = 794.0 / 96.0;
const PAGE_H_IN: f64 = 1123.0 / 96.0;

/// 打印等多久算超时。长文档 + 慢机器留足余量。
const PRINT_TIMEOUT: Duration = Duration::from_secs(180);

/// 注入的覆盖样式 id。
///
/// 注入与撤销两段脚本共用它：id 一旦对不上，
/// 导出完就会在 `<head>` 里留下一个永久的白色覆盖层。
const WHITE_BASE_ID: &str = "__re-export-white__";

/// id 在两段脚本里的占位符。用替换而不是 `format!`，
/// 这样脚本本身不必转义一堆花括号。
const ID_PLACEHOLDER: &str = "__RE_EXPORT_ID__";

/// 把"应用外壳"的底色刷成白色。
///
/// 只碰 `html/body/#root` 这三层。文档自己的背景色由 DesignSpec 决定，
/// 覆盖它会把用户选的配色改掉 —— 那是导出，不是换主题。
const WHITE_BASE_JS: &str = r#"(function () {
  if (document.getElementById('__RE_EXPORT_ID__')) { return; }
  var style = document.createElement('style');
  style.id = '__RE_EXPORT_ID__';
  style.textContent = 'html,body,#root{background:#ffffff !important;}';
  document.head.appendChild(style);
})();"#;

/// 撤掉上面的覆盖样式。
const REMOVE_WHITE_BASE_JS: &str = r#"(function () {
  var el = document.getElementById('__RE_EXPORT_ID__');
  if (el && el.parentNode) { el.parentNode.removeChild(el); }
})();"#;

fn white_base_js() -> String {
    WHITE_BASE_JS.replace(ID_PLACEHOLDER, WHITE_BASE_ID)
}

fn remove_white_base_js() -> String {
    REMOVE_WHITE_BASE_JS.replace(ID_PLACEHOLDER, WHITE_BASE_ID)
}

/// 当前平台的导出能力。与前端 `ExportSupport` 一一对应。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSupport {
    pub pdf: bool,
    pub platform: String,
    pub note: String,
}

pub fn support() -> ExportSupport {
    ExportSupport {
        pdf: cfg!(windows),
        platform: std::env::consts::OS.to_string(),
        note: if cfg!(windows) {
            "PDF 由 WebView2 直接打印：文字可选中、可搜索，按 A4 精确分页。".to_string()
        } else {
            "当前平台没有可用的 PDF 打印后端。".to_string()
        },
    }
}

/// 把主窗口当前渲染的内容打印成 PDF，返回实际写入的路径。
pub fn export_pdf(window: &WebviewWindow, path: &str) -> Result<String> {
    let target = PathBuf::from(path);
    if target.as_os_str().is_empty() {
        return Err(CommandError::invalid("没有指定导出路径。"));
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                CommandError::export(format!("创建导出目录 {} 失败：{e}", parent.display()))
            })?;
        }
    }

    let (tx, rx) = channel::<std::result::Result<(), String>>();
    let target_for_webview = target.clone();

    window
        .with_webview(move |platform| {
            // 这个闭包跑在主线程上，它只负责**发起**。
            // 绝不在这里等回调 —— 回调要靠主线程消息泵派发，在这里等就是
            // 把泵堵死（见文件头第 1 条）。
            let tx_err = tx.clone();
            if let Err(message) = start_print(&platform, &target_for_webview, tx) {
                log_line(&format!("导出[!] 发起失败：{message}"));
                // 必须把错误送出去，否则调用线程会一直等到超时。
                let _ = tx_err.send(Err(message));
            }
        })
        .map_err(|e| CommandError::export(format!("拿不到主窗口的 webview：{e}")))?;

    // 在**调用线程**上等。此刻主线程已经空闲下来，Tauri 的正常消息循环会把
    // 打印完成的回调派发出去。
    match rx.recv_timeout(PRINT_TIMEOUT) {
        Ok(Ok(())) => {
            // 打完再把刷白撤销，免得界面上留一层白罩。
            // `eval` 可以从任意线程调用（Tauri 内部会转投到主线程）。
            match window.eval(remove_white_base_js()) {
                Ok(()) => log_line("导出[8] 已撤销刷白"),
                Err(e) => log_line(&format!("导出[8] 撤销刷白失败（无碍）：{e}")),
            }
            Ok(target.to_string_lossy().into_owned())
        }
        Ok(Err(message)) => Err(CommandError::export(message)),
        Err(_) => Err(CommandError::export(
            "打印超时（超过 3 分钟没有结果）。文档可能过大，可以试试分页导出。",
        )),
    }
}

/// 发起打印：**只发起，不等回调**。运行在主线程上。
///
/// 顺序是「先刷白应用外壳，再发起打印」。两步都是投给 WebView2 的异步请求，
/// 走同一条队列，先入队的先被处理，所以不需要等第一段跑完 —— 而"等"在这里
/// 恰恰是不能做的事（见文件头第 1 条）。
fn start_print(
    platform: &tauri::webview::PlatformWebview,
    target: &Path,
    tx: Sender<std::result::Result<(), String>>,
) -> std::result::Result<(), String> {
    let controller = platform.controller();
    let webview: ICoreWebView2 = unsafe { controller.CoreWebView2() }
        .map_err(|e| format!("拿不到 WebView2 实例：{e}"))?;
    log_line("导出[2] 拿到 WebView2 实例");

    // 打印接口挂在 ICoreWebView2_7 上（WebView2 运行时 1.0.1108+）。
    // 现在的 Edge 都远高于这个版本，但老系统上仍可能缺 —— 报清楚比崩掉好。
    let printer: ICoreWebView2_7 = webview.cast().map_err(|_| {
        "当前 WebView2 运行时不支持打印（需要 1.0.1108 以上）。\n\
         请更新 Microsoft Edge WebView2 运行时后重试。"
            .to_string()
    })?;

    // `CreatePrintSettings` 在 ICoreWebView2Environment6 上（不是基础的
    // ICoreWebView2Environment），所以要往上 cast 一层。
    let environment: ICoreWebView2Environment6 = platform.environment().cast().map_err(|_| {
        "当前 WebView2 运行时不支持打印（需要 1.0.1108 以上）。\n\
         请更新 Microsoft Edge WebView2 运行时后重试。"
            .to_string()
    })?;
    let settings: ICoreWebView2PrintSettings = unsafe { environment.CreatePrintSettings() }
        .map_err(|e| format!("创建打印设置失败：{e}"))?;
    configure_print(&settings)?;
    log_line("导出[4] 打印设置就绪");

    // 刷白应用外壳。不等回调（理由见上）；失败不致命 —— 最坏是深色主题下
    // 导出的 PDF 边角带一点深色。
    let script_h = HSTRING::from(white_base_js());
    let noop = ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
    match unsafe { webview.ExecuteScript(&script_h, &noop) } {
        Ok(()) => log_line("导出[5] 刷白外壳已入队"),
        Err(e) => log_line(&format!("导出[5] 刷白外壳失败（照常打印）：{e}")),
    }

    print_to_file(&printer, &settings, target, tx)
}

/// 组装「设置 X 失败」的文案。
///
/// 单独写成函数而不是闭包：闭包没法在借用 `what` 的同时返回另一个闭包
/// （返回类型里带着 `what` 的生命周期，借用检查器会拒绝）。
fn set_failed(what: &str, e: windows::core::Error) -> String {
    format!("设置{what}失败：{e}")
}

fn configure_print(settings: &ICoreWebView2PrintSettings) -> std::result::Result<(), String> {
    unsafe {
        // 文档自带背景色，不打印背景等于导出一张白纸。
        settings
            .SetShouldPrintBackgrounds(true)
            .map_err(|e| set_failed("打印背景", e))?;
        settings
            .SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)
            .map_err(|e| set_failed("纸张方向", e))?;
        settings
            .SetScaleFactor(1.0)
            .map_err(|e| set_failed("缩放比例", e))?;
        settings
            .SetPageWidth(PAGE_W_IN)
            .map_err(|e| set_failed("纸张宽度", e))?;
        settings
            .SetPageHeight(PAGE_H_IN)
            .map_err(|e| set_failed("纸张高度", e))?;
        // 页边距由文档自己的 padding 提供（见 render.ts 的 .doc 与 @media print），
        // 这里再加一圈就会出现双重留白。
        settings
            .SetMarginTop(0.0)
            .map_err(|e| set_failed("上边距", e))?;
        settings
            .SetMarginBottom(0.0)
            .map_err(|e| set_failed("下边距", e))?;
        settings
            .SetMarginLeft(0.0)
            .map_err(|e| set_failed("左边距", e))?;
        settings
            .SetMarginRight(0.0)
            .map_err(|e| set_failed("右边距", e))?;
    }
    Ok(())
}

/// 发起 `PrintToPdf`。结果由完成回调送进 `tx`，在**调用线程**上收。
fn print_to_file(
    printer: &ICoreWebView2_7,
    settings: &ICoreWebView2PrintSettings,
    target: &Path,
    tx: Sender<std::result::Result<(), String>>,
) -> std::result::Result<(), String> {
    let tx_handler = tx.clone();
    let handler = PrintToPdfCompletedHandler::create(Box::new(move |error, ok| {
        log_line("导出[7b] 打印完成回调到达");
        let outcome = match error {
            Err(e) => Err(format!("WebView2 打印失败：{e}")),
            Ok(()) if !ok => Err("WebView2 报告打印未成功完成。".to_string()),
            Ok(()) => Ok(()),
        };
        let _ = tx_handler.send(outcome);
        Ok(())
    }));

    let path_h = HSTRING::from(target.as_os_str());

    match unsafe { printer.PrintToPdf(&path_h, settings, &handler) } {
        Ok(()) => {
            log_line("导出[7] PrintToPdf 已发起，等回调（在调用线程上）");
            Ok(())
        }
        Err(e) => {
            // 发起都失败了，回调永远不会来 —— 必须自己把错误送出去，
            // 否则调用线程要一直等到超时。
            let message = format!("发起打印失败：{e}");
            let _ = tx.send(Err(message.clone()));
            Err(message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_size_matches_the_frontend_a4_constants() {
        // 前端：A4_WIDTH_PX = 794，A4_HEIGHT_PX = 1123（@96dpi）。
        // 这两条断言是"预览页数 == 导出页数"的前提。
        assert!((PAGE_W_IN * 96.0 - 794.0).abs() < 1e-9);
        assert!((PAGE_H_IN * 96.0 - 1123.0).abs() < 1e-9);
    }

    #[test]
    fn page_is_a4_shaped() {
        assert!(PAGE_W_IN < PAGE_H_IN);
        // 8.27 × 11.69 英寸，误差在 0.01 英寸内。
        assert!((PAGE_W_IN - 8.27).abs() < 0.01);
        assert!((PAGE_H_IN - 11.69).abs() < 0.01);
    }

    #[test]
    fn the_injected_style_only_touches_the_app_shell() {
        // 文档自己的配色（DesignSpec 的 palette.bg）不能被覆盖。
        assert!(WHITE_BASE_JS.contains("html,body,#root"));
        assert!(!WHITE_BASE_JS.contains(".doc"));
    }

    #[test]
    fn inject_and_remove_share_one_id() {
        // 两段脚本的 id 对不上，导出完就会在 <head> 里留下一个永久的白罩。
        let inject = white_base_js();
        let remove = remove_white_base_js();
        assert!(inject.contains(WHITE_BASE_ID));
        assert!(remove.contains(WHITE_BASE_ID));
        // 占位符必须被替换干净，否则 id 会真的叫 __RE_EXPORT_ID__。
        assert!(!inject.contains(ID_PLACEHOLDER));
        assert!(!remove.contains(ID_PLACEHOLDER));
    }

    #[test]
    fn the_injected_style_is_idempotent() {
        // 重复注入不该堆出一串 style 标签。
        assert!(white_base_js().contains("if (document.getElementById"));
    }

    #[test]
    fn support_reports_pdf_on_windows() {
        let s = support();
        assert_eq!(s.pdf, cfg!(windows));
        assert!(!s.note.is_empty());
        assert!(!s.platform.is_empty());
    }

    #[test]
    fn support_serializes_as_camel_case() {
        let json = serde_json::to_value(support()).unwrap();
        assert!(json.get("pdf").is_some());
        assert!(json.get("platform").is_some());
        assert!(json.get("note").is_some());
    }
}
