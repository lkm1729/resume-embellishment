//! 应用入口与全部 Tauri 命令。
//!
//! # 启动顺序不可调换
//!
//! ```text
//! ① logging::previous_run_crashed()   ← 必须在 ② 之前
//! ② logging::install()                 装了 panic 钩子，崩溃才有痕迹
//! ③ claim_single_instance()            抢 WebView2 用户数据目录的独占权
//! ④ prepare_profile(crashed)           上次崩溃过就把可能损坏的 profile 挪开
//! ⑤ tauri::Builder                     建窗口
//! ```
//!
//! ① 与 ② 的顺序是最容易写错的一处：`install()` 会把本次启动的标记写进日志，
//! 之后再读日志判断"上次是否崩溃"就恒为真，应用会每次启动都去挪 profile。
//!
//! # 前端契约
//!
//! 命令名与参数形状必须与下面三个文件严格一致，它们是唯一的前端入口：
//! `src/core/llm/api.ts`（14 个命令）、`src/core/google/api.ts`（7 个命令）
//! 与 `src/core/history/api.ts`（6 个命令）。
//! Tauri v2 默认把命令参数名转成 camelCase，
//! 所以这里的 `api_key` / `base_url` / `model_id` / `docx_base64` 收到的就是
//! 前端的 `apiKey` / `baseUrl` / `modelId` / `docxBase64`。

mod error;
mod export;
mod fetch;
mod fonts;
mod google;
mod history;
mod llm;
mod logging;
mod persist;
mod providers;
mod secrets;
mod webview_guard;

use crate::error::{CommandError, Result};
use crate::llm::client::Endpoint;

/// 应用名。单实例提示、崩溃说明都用它。
const APP_TITLE: &str = "简历与求职信美化";

/// 主窗口的 label。tauri.conf.json 里那一项标了 `"create": false`，
/// 由 `run()` 里的 setup 用 `WebviewWindowBuilder::from_config` 亲手建出来。
const MAIN_WINDOW_LABEL: &str = "main";

// ─────────────────────── 密钥环 / 供应商 ───────────────────────

/// 检查系统密钥环是否可用。不可用时前端会提示用户而不是直接失败。
#[tauri::command]
fn keyring_status() -> Result<()> {
    secrets::status()
}

#[tauri::command]
fn list_providers() -> Result<Vec<providers::Provider>> {
    providers::load_all()
}

/// 新增或更新供应商。
///
/// `api_key` 为空时**保持原有密钥不变** —— 用户改 Base URL 或名字时
/// 不该被迫重新粘贴一次密钥。
#[tauri::command]
fn save_provider(
    provider: providers::Provider,
    api_key: Option<String>,
) -> Result<providers::Provider> {
    let key = api_key.unwrap_or_default();
    let saved = providers::upsert(provider)?;
    let key = key.trim();
    if !key.is_empty() {
        secrets::store(&saved.secret_ref, key)?;
    }
    Ok(saved)
}

#[tauri::command]
fn delete_provider(id: String) -> Result<()> {
    if let Some(secret_ref) = providers::remove(&id)? {
        // 供应商已经删掉了，密钥删不掉也不该让整个操作失败 ——
        // 最坏是凭据管理器里留一个没人引用的条目。
        let _ = secrets::delete(&secret_ref);
    }
    Ok(())
}

/// 批量删除。返回实际删除的数量（不存在的 id 不计入）。
#[tauri::command]
fn delete_providers(ids: Vec<String>) -> Result<usize> {
    let (count, secret_refs) = providers::remove_many(&ids)?;
    for secret_ref in secret_refs {
        let _ = secrets::delete(&secret_ref);
    }
    Ok(count)
}

/// 该供应商是否已配置密钥。只回答有/没有，不返回密钥内容。
#[tauri::command]
fn provider_has_key(id: String) -> Result<bool> {
    let provider = providers::find(&id)?;
    Ok(secrets::has(&provider.secret_ref))
}

// ─────────────────────── 模型列表 / 生成 ───────────────────────

/// 取这次调用该用的密钥：显式传进来的优先，否则用已保存的。
fn resolve_key(provider: &providers::Provider, api_key: Option<String>) -> Result<String> {
    match api_key {
        Some(key) if !key.trim().is_empty() => Ok(key.trim().to_string()),
        _ => secrets::require(&provider.secret_ref),
    }
}

#[tauri::command]
async fn fetch_models(id: String, api_key: Option<String>) -> Result<Vec<providers::ModelInfo>> {
    let provider = providers::find(&id)?;
    let key = resolve_key(&provider, api_key)?;
    let ep = Endpoint::from_provider(&provider, key);
    llm::client::list_models(&ep).await
}

/// 供应商还没保存时，直接用 Base URL + Key 试拉一次模型列表。
#[tauri::command]
async fn fetch_models_raw(
    base_url: String,
    api_key: String,
) -> Result<Vec<providers::ModelInfo>> {
    // `/models` 与协议无关，用一个不会因为协议选错而失败的默认值。
    let ep = Endpoint::new(base_url, providers::Protocol::ChatCompletions, api_key);
    llm::client::list_models(&ep).await
}

/// 测连通性。
///
/// 探测本身**不返回错误**：连不上是一个结果（`ProbeResult.ok = false`），
/// 而不是一次失败。只有"连密钥都取不到"这类前置问题才用 `Err`。
#[tauri::command]
async fn test_provider(
    id: String,
    model_id: String,
    api_key: Option<String>,
) -> Result<providers::ProbeResult> {
    let provider = providers::find(&id)?;
    let key = resolve_key(&provider, api_key)?;
    let ep = Endpoint::from_provider(&provider, key);
    let probe = llm::client::probe(&ep, &model_id).await;
    // 把结果记下来，下次打开设置页不必重测。写盘失败不影响本次探测结果。
    let _ = providers::record_probe(&id, probe.clone());
    Ok(probe)
}

/// 调用模型生成内容。
///
/// 这是**纯传输**：返回模型原始文本，提取 JSON、校验、修复轮都在前端
/// `core/design/generate.ts` 里做。后端刻意不解析生成结果，
/// 否则 DesignSpec 的结构会在前后端各存一份、迟早漂移。
#[tauri::command]
async fn generate_design_spec(
    id: String,
    model_id: String,
    request: llm::types::ChatRequest,
    api_key: Option<String>,
) -> Result<llm::types::ChatResponse> {
    let provider = providers::find(&id)?;
    let key = resolve_key(&provider, api_key)?;
    let ep = Endpoint::from_provider(&provider, key);
    llm::client::chat(&ep, &model_id, &request).await
}

// ─────────────────────────── 导出 ───────────────────────────

/// 把当前页面打印为矢量 PDF。
///
/// ⚠ 调用前前端必须已经把界面切成「导出视图」：
/// `PrintToPdf` 打的是整个 webview，界面上有什么就会被印进去。
///
/// ⚠ 必须是 `async` + `spawn_blocking`。**同步命令跑在主线程上**，而
/// WebView2 的打印完成回调要靠主线程的消息泵派发 —— 在主线程上阻塞等待
/// 打印结果，就是把泵堵死，回调永远来不了，命令只能一路挂到超时。
/// 实测证据：同步版本里日志停在「PrintToPdf 已发起，等回调」，
/// 之后 `导出[7b] 打印完成回调到达` 从未出现。
#[tauri::command]
async fn export_pdf(window: tauri::WebviewWindow, path: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || export::export_pdf(&window, &path))
        .await
        .map_err(|e| crate::error::CommandError::export(format!("导出任务没能启动：{e}")))?
}

#[tauri::command]
fn export_support() -> export::ExportSupport {
    export::support()
}

// ─────────────────────────── 网页抓取 ───────────────────────────

#[tauri::command]
async fn fetch_url(url: String) -> Result<fetch::FetchedPage> {
    fetch::fetch(&url).await
}

// ─────────────────────────── 系统字体 ───────────────────────────

/// 列出本机已安装的字体族，供前端做自定义字体选择。
///
/// 刻意写成 async：同步命令跑在主线程上，而枚举字体要遍历几百个族
/// （每个族还会按字符集被回报多次），放在主线程会让窗口僵一下。
#[tauri::command]
async fn list_system_fonts() -> Result<Vec<String>> {
    fonts::list_families()
}

// ────────────────── 外部跳转 / Google Docs 同步 ──────────────────

/// 把地址交给系统默认浏览器。只放行 http 与 https：这个函数把字符串交给
/// 操作系统的壳，放行别的协议等于给「打开任意本地程序」开了个口子。
fn open_in_browser(url: &str) -> Result<()> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err(CommandError::invalid(format!(
            "只允许打开 http / https 地址，收到的是：{trimmed}"
        )));
    }
    tauri_plugin_opener::open_url(trimmed, None::<&str>)
        .map_err(|e| CommandError::new("opener", format!("打不开浏览器：{e}")))
}

/// 在系统默认浏览器里打开一个地址。
///
/// 界面上普通写 `<a href="https://…">` 的链接走的是**另一条**路：opener 插件
/// 注入的脚本拦下点击，转去调 `plugin:opener|open_url` 命令。那条路要同时
/// 有 `opener:allow-open-url`（开命令）**和** `opener:allow-default-urls`
/// （给 URL 作用域）才通 —— 少了后者会**静默**失效：脚本先 preventDefault
/// 再 invoke，命令返回 ForbiddenUrl，而脚本没有 catch，用户看到的就是
/// 「点了没反应」。能力声明在 `capabilities/default.json`，那里有一条测试
/// 守着（`the_opener_url_scope_actually_allows_the_console_links`）。
///
/// 这个命令走的是自由函数，**不经过权限作用域**，是给「上传完成后自动打开」
/// 这类没有点击可依的场合用的。
#[tauri::command]
fn open_external(url: String) -> Result<()> {
    open_in_browser(&url)
}

/// Google 授权状态。只回答「填过没有 / 连过没有」，不含任何密钥字段。
#[tauri::command]
fn google_status() -> Result<google::GoogleStatus> {
    google::status()
}

/// 保存用户从 Google Cloud Console 复制来的 Client ID 与 Client Secret。
#[tauri::command]
fn google_save_credentials(client_id: String, client_secret: String) -> Result<google::GoogleStatus> {
    google::save_client(&client_id, &client_secret)
}

/// 断开：清掉长期凭据，保留客户端字段（用户多半只是想换个账号）。
#[tauri::command]
fn google_disconnect() -> Result<google::GoogleStatus> {
    google::disconnect()
}

/// 连接：弹出系统默认浏览器让用户登录并授权，授权完成后自动回到本程序。
#[tauri::command]
async fn google_connect() -> Result<google::GoogleStatus> {
    google::connect().await
}

/// 让正在等待的那次 `google_connect` 立刻收手。
///
/// 单独立一个命令而不是给 `google_connect` 加个超时参数：等回调最长
/// 五分钟，用户改主意时那条命令正挂在 `await` 上 —— 只有另一个命令
/// 才能把它放倒。返回 `()`：取消本身没什么可说的，前端只要把等待态
/// 收掉、把 `google_connect` 抛回来的错误显示出来就行。
#[tauri::command]
fn google_cancel() {
    google::cancel();
}

/// 把 .docx（base64）上传成一份 Google 文档，返回可打开的地址。
#[tauri::command]
async fn google_upload_docx(name: String, docx_base64: String) -> Result<google::GoogleDoc> {
    google::upload_docx(name, docx_base64).await
}

// ─────────────────────────── 历史记录 ───────────────────────────

#[tauri::command]
fn list_history() -> Result<Vec<history::HistoryEntry>> {
    history::load_all()
}

/// 返回因超出上限被丢弃的条数。
#[tauri::command]
fn add_history(entry: history::HistoryEntry) -> Result<usize> {
    history::add(entry)
}

#[tauri::command]
fn get_history(id: String) -> Result<history::HistoryEntry> {
    history::get(&id)
}

#[tauri::command]
fn delete_history(id: String) -> Result<()> {
    history::delete(&id)
}

#[tauri::command]
fn delete_history_many(ids: Vec<String>) -> Result<usize> {
    history::delete_many(&ids)
}

#[tauri::command]
fn clear_history() -> Result<usize> {
    history::clear()
}

// ─────────────────────────── 入口 ───────────────────────────

pub fn run() {
    // ① 必须在 install() 之前读，理由见模块头。
    let crashed = logging::previous_run_crashed();

    // ② 发布版没有控制台（`windows_subsystem = "windows"` + `strip = true`），
    //    没有这个钩子，任何 panic 都是彻底无声的 —— 用户只看到窗口闪一下。
    logging::install();

    // ③ 两个实例会抢同一个 WebView2 用户数据目录，第二个必然失败。
    if !webview_guard::claim_single_instance() {
        webview_guard::show_message(
            APP_TITLE,
            "应用已经在运行了。\n\n\
             请切换到已经打开的窗口，或者先关掉它再重试。",
        );
        // 必须写这一行：否则这次"没进主流程"的退出会被下次启动判成异常退出。
        logging::mark_clean_exit();
        return;
    }

    // ④ 只在上次真的崩溃过时才动手，免得每次正常关闭都白挪一趟用户数据。
    if let Some(fresh) = webview_guard::prepare_profile(crashed) {
        logging::log_line(&format!("WebView2 用户数据目录已切换到 {}", fresh.display()));
    }

    // ⑤
    let outcome = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            // 主窗口在 tauri.conf.json 里标了 `"create": false` —— 不是漏写，
            // 是刻意的：窗口只能由 builder 建出来，建完就再没有地方挂
            // `on_new_window` 了，而那个处理器是必须挂的（理由见下面那段）。
            // `from_config` 就是 Tauri 给这种情况留的口子。
            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == MAIN_WINDOW_LABEL)
                .cloned()
                .ok_or_else(|| {
                    // 真走到这里，用户看到的是「双击了，什么都没出现」，
                    // 唯一能留下线索的地方就是日志。
                    std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        format!("tauri.conf.json 里没有 label 为 {MAIN_WINDOW_LABEL} 的窗口"),
                    )
                })?;

            tauri::WebviewWindowBuilder::from_config(app, &window_config)?
                .on_new_window(|url, _features| {
                    // 右键链接 →「在新窗口中打开链接」不走页面里的 click 事件，
                    // 而是 WebView2 的 NewWindowRequested。wry 在**没有**处理器
                    // 时会直接把它 SetHandled(true) 否掉
                    // （wry-0.57.0\src\webview2\mod.rs:848-850），于是和左边那条
                    // 路径一样表现为「点了没反应」，同样连个错都不报。
                    //
                    // 送进系统默认浏览器，再返回 Deny：让 WebView2 不要另外开一个
                    // 没有地址栏、也关不掉的裸窗口。
                    if let Err(e) = open_in_browser(url.as_str()) {
                        logging::log_line(&format!("新窗口请求没能交给浏览器：{url}（{e}）"));
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;

            // 走到这里说明窗口和 webview 都建起来了，
            // 前端之后的报错就可以放心归因到业务代码。
            logging::mark_ready();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            keyring_status,
            list_providers,
            save_provider,
            delete_provider,
            delete_providers,
            provider_has_key,
            fetch_models,
            fetch_models_raw,
            test_provider,
            generate_design_spec,
            export_pdf,
            export_support,
            fetch_url,
            list_system_fonts,
            open_external,
            google_status,
            google_save_credentials,
            google_disconnect,
            google_connect,
            google_cancel,
            google_upload_docx,
            list_history,
            add_history,
            get_history,
            delete_history,
            delete_history_many,
            clear_history,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = outcome {
        logging::log_line(&format!("{} 事件循环异常结束：{e}", logging::PANIC_MARK));
    }
    logging::mark_clean_exit();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端 `src/core/llm/api.ts`、`src/core/history/api.ts` 与
    /// `src/core/google/api.ts` 里的命令名。
    /// 改名会在这里先断，而不是等到运行时才发现"命令不存在"。
    const COMMAND_NAMES: &[&str] = &[
        "keyring_status",
        "list_providers",
        "save_provider",
        "delete_provider",
        "delete_providers",
        "provider_has_key",
        "fetch_models",
        "fetch_models_raw",
        "test_provider",
        "generate_design_spec",
        "export_pdf",
        "export_support",
        "fetch_url",
        "list_system_fonts",
        "open_external",
        "google_status",
        "google_save_credentials",
        "google_disconnect",
        "google_connect",
        "google_cancel",
        "google_upload_docx",
        "list_history",
        "add_history",
        "get_history",
        "delete_history",
        "delete_history_many",
        "clear_history",
    ];

    #[test]
    fn the_command_list_matches_the_three_frontend_modules() {
        // 14 个来自 api.ts，7 个来自 google/api.ts，6 个来自 history/api.ts。
        assert_eq!(COMMAND_NAMES.len(), 27);
        assert_eq!(COMMAND_NAMES.iter().filter(|n| n.starts_with("fetch")).count(), 3);
        assert_eq!(COMMAND_NAMES.iter().filter(|n| n.starts_with("google_")).count(), 6);
    }

    #[test]
    fn command_names_are_unique_and_snake_case() {
        let mut seen = std::collections::HashSet::new();
        for name in COMMAND_NAMES {
            assert!(seen.insert(*name), "重复的命令名：{name}");
            assert_eq!(name.to_lowercase(), **name, "命令名必须全小写：{name}");
            assert!(!name.contains('-'), "命令名不能用连字符：{name}");
        }
    }

    /// 配置向导里那三个「去 Google Cloud Console」的链接，点了到底能不能开。
    ///
    /// 这条测试守的是一类**没有报错**的失败：点了完全没反应。
    /// opener 插件注册时往页面里注入一段脚本（`open_js_links_on_click` 默认开），
    /// 它把 `<a target="_blank" href="https://…">` 的点击 `preventDefault()` 掉，
    /// 再 `invoke("plugin:opener|open_url")` —— **没有 await，也没有 catch**。
    /// 而那条命令会先拿 URL 去比对权限作用域（插件 `scope.rs` 的
    /// `is_url_allowed`：`allowed.iter().any(…)`），比对不上就返回
    /// `ForbiddenUrl`。于是：点击被 preventDefault 吞掉、错误没人接、
    /// 用户看到的就是「点了没反应」。
    ///
    /// 空作用域是很容易造出来的：`opener:allow-open-url` 按定义是
    /// "Enables the open_url command **without any pre-configured scope**"，
    /// 真正给出 `https://*` 的是**另一个**权限 `opener:allow-default-urls`。
    /// 只写前者不写后者，一切编译通过、运行时静默失效。
    ///
    /// 所以这里不去手写一遍规则（那只能测出我理解的 Tauri 应该怎么工作），
    /// 而是把**启动时真正会跑的那段解析**请出来跑：同一份
    /// `acl-manifests.json`、同一份 capability 文件、同一个 `Resolved::resolve`，
    /// 再看这条命令最后拿到的放行清单里有没有一条能匹配上真实网址。
    #[test]
    fn the_opener_url_scope_actually_allows_the_console_links() {
        use tauri::utils::acl::{
            capability::CapabilityFile, manifest::Manifest, resolved::Resolved,
        };
        use tauri::utils::platform::Target;

        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));

        // ① 权限清单：tauri-build 把各插件自带的 permission 定义汇总到这里。
        let acl: std::collections::BTreeMap<String, Manifest> = serde_json::from_str(
            &std::fs::read_to_string(dir.join("gen/schemas/acl-manifests.json")).expect(
                "读不到 gen/schemas/acl-manifests.json —— 它由 tauri-build 生成，先跑一次 cargo build",
            ),
        )
        .expect("acl-manifests.json 应该是 Tauri 能解析的形状");

        // ② 应用的 capability：就是仓库里这一份，不是副本。
        let capability = match CapabilityFile::load(dir.join("capabilities/default.json"))
            .expect("capabilities/default.json 应该能读出来")
        {
            CapabilityFile::Capability(capability) => capability,
            // CapabilityFile 的 Debug 是 tauri-utils 自己的 cfg(test) 才有的，
            // 我们这边打印不出来，只能说清楚期望的形状。
            _ => panic!(
                "capabilities/default.json 必须是单个 capability 对象（CapabilityFile::Capability）"
            ),
        };
        let identifier = capability.identifier.clone();
        let capabilities = std::collections::BTreeMap::from([(identifier, capability)]);

        // ③ 跑 Tauri 启动时跑的那段解析。解析不了的话应用根本起不来，
        //    所以这里失败必定是我的改动坏了，不是环境问题。
        let resolved = Resolved::resolve(&acl, capabilities, Target::Windows)
            .expect("ACL 应该能解析");

        // ④ 收集这条命令的作用域。Tauri 把它拆成两份存放：
        //    带 commands 的权限（allow-open-url）落 command_scope，
        //    只带 scope 的权限（allow-default-urls）落 global_scope。
        //    插件那边是把两份串起来一起比对的，所以这里也必须两份都收，
        //    否则「补了 allow-default-urls 却仍然报红」会把人引到错误方向。
        let commands = resolved
            .allowed_commands
            .get("plugin:opener|open_url")
            .expect("capabilities/default.json 里应该有 opener:allow-open-url");
        // ACL 里的值类型是 tauri-utils 自己的 Value（不是 serde_json::Value），
        // 它有到 serde_json::Value 的 From，转一道才方便按 key 取 url。
        let to_json = |scope: &tauri::utils::acl::resolved::ResolvedScope| -> Vec<serde_json::Value> {
            scope.allow.iter().cloned().map(serde_json::Value::from).collect()
        };
        let mut allow: Vec<serde_json::Value> = Vec::new();
        for command in commands {
            if let Some(scope) = command
                .scope_id
                .and_then(|id| resolved.command_scope.get(&id))
            {
                allow.extend(to_json(scope));
            }
        }
        // 全局作用域按**插件名**存，不是按命令名 —— 这一条是踩出来的：
        // resolve 内部那句 format!("plugin:{key}|{command}") 里的 key 就是插件名
        // （tauri-utils 自己的测试也断言 permissions[0].key == "fs"）。
        if let Some(scope) = resolved.global_scope.get("opener") {
            allow.extend(to_json(scope));
        }

        // ⑤ 用真实链接验收。这三个就是配置向导里那三个，与
        //    src/core/google/api.ts 的 GOOGLE_CONSOLE_LINKS 一一对应——
        //    测试里重抄一份是刻意的：抄错了会在这里断，而不是等用户去点。
        let links = [
            "https://console.cloud.google.com/apis/library/drive.googleapis.com",
            "https://console.cloud.google.com/apis/credentials/consent",
            "https://console.cloud.google.com/apis/credentials",
        ];

        for link in links {
            let allowed = allow.iter().any(|entry| {
                entry
                    .get("url")
                    .and_then(|url| url.as_str())
                    .and_then(|pattern| glob::Pattern::new(pattern).ok())
                    .is_some_and(|pattern| pattern.matches(link))
            });
            assert!(
                allowed,
                "opener 的 URL 作用域没有放行 {link}，而界面上点它**不会有任何反应**。\n\
                 多半是 capabilities/default.json 少了 \"opener:allow-default-urls\"\n\
                 （opener:allow-open-url 只开命令、按定义不带任何作用域，\n\
                 给出 https://* 的是 allow-default-urls）。\n\
                 当前放行清单：{allow:?}"
            );
        }
    }

    #[test]
    fn the_key_resolution_prefers_an_explicit_key() {
        let provider = providers::Provider {
            id: "p1".into(),
            name: "本地".into(),
            base_url: "http://localhost:1234/v1".into(),
            protocol: providers::Protocol::ChatCompletions,
            secret_ref: "__re_test_never_stored__".into(),
            models: Vec::new(),
            last_probe: None,
        };
        // 显式给了密钥就用它，不会去碰凭据管理器。
        assert_eq!(resolve_key(&provider, Some("sk-x".into())).unwrap(), "sk-x");
        // 空白视为没给 —— 前端会把"没填"传成 null，但空串也得当没填。
        assert!(resolve_key(&provider, Some("   ".into())).is_err());
    }
}
