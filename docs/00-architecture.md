# 00 · 架构总览

> 「简历 & 求职信视觉设计美化工具」—— **只改版式，不改文字**。
> 用户粘进来的是自己的简历/求职信，程序负责把它排得好看，然后导出成 PDF 或 PNG。

## 1. 一句话架构

```
                     ┌─────────────────────── 前端（React 19 + TS）───────────────────────┐
 用户文本 ──► 内容解析 ──► ContentUnit[] ──┐                                              │
                                          │                                              │
                     LLM ──► DesignSpec ──┴──► render(ContentUnit[], DesignSpec) ──► HTML│
                                                                       │                 │
                                                        ┌──────────────┴──────────────┐  │
                                                        ▼                             ▼  │
                                                    预览面板                    PDF / PNG 导出
                                                        │                             │
                                                        └──── 历史记录（回滚）─────────┘
                     └──────────────────────────────────────────────────────────────┘
                          ▲ invoke()                                    ▼ 命令
                     ┌──────────────────────── Rust 后端（tauri）────────────────────────┐
                     │  providers / keyring / llm  ·  export（WebView2 打印）            │
                     │  history（JSON 库）        ·  fetch（正文抽取）                  │
                     └────────────────────────────────────────────────────────────────┘
```

## 2. 最硬的一条不变量

**`DesignSpec` 里没有任何字段可以承载用户的正文文字。** 它只能引用 `contentId`。

```
ContentUnit { id, kind, text, level? }     ← 用户的原文，只在这里
DesignSpec   { …样式…, blocks: [{ contentId, … }] }   ← LLM 只能产出样式
```

这样「LLM 会不会偷偷改用户的话」不是靠事后校验，而是**类型系统**保证的：
LLM 拿不到写正文的位置，它只能给已有的 `contentId` 指定样式。渲染器再从
`ContentUnit[]` 里按 id 取回原文拼进 HTML。任何未知 `contentId` 都会被渲染层忽略。

## 3. 分层

| 目录 | 职责 | 关键点 |
| --- | --- | --- |
| `src/core/design/` | 设计稿的类型、zod 校验、`FONT_WHITELIST` | 文档字体只允许系统自带字体 |
| `src/core/content/` | 解析粘贴文本 / docx，切分 `ContentUnit` | 不修改文字本身 |
| `src/core/llm/` | 提供商配置、keyring 密钥、13 个后端命令的封装 | 密钥永不落盘到 JSON |
| `src/core/render/` | **纯函数** `(ContentUnit[], DesignSpec) → HTML` | 预览/导出/历史回滚共用同一个函数 |
| `src/core/export/` | PDF（Rust 打印）、PNG（pdfjs 栅格化）、画布守卫 | 尺寸守卫写在源码里，`tools/verify-png-pipeline.mjs` 会读它 |
| `src/core/history/` | 历史记录（6 个命令） | 存 `contentSnapshot`，回滚不需要重新调 LLM |
| `src/core/store/` | zustand：设计稿、导出选项、界面状态 | 单一数据源 |
| `src/core/ui/` | 主题（浅/深/跟随系统）、版本标签 | 主题靠 CSS 变量，不触调用点 |
| `src/features/` | 界面：外壳、预览、提供商表单、历史面板 | 不直接碰 Rust，只走 `core/*/api.ts` |

渲染层是**纯函数**这件事很关键：预览面板、PDF 导出视图、历史回滚三者喂的是同一份
`(ContentUnit[], DesignSpec)`，所以「预览看到什么，导出就是什么」是结构上成立的，
不是靠对两套模板。

## 4. 导出通路

### 4.1 PDF（矢量）

1. 前端切到「导出视图」，等两帧绘制完成；
2. `invoke('export_pdf', { path })`；
3. Rust 侧 `export.rs`：拿 WebView2 → `CreatePrintSettings()`（A4、无页边距、
   打印背景）→ `PrintToPdf(&path, settings, handler)`；
4. 完成回调到达后命令返回路径；
5. 前端在 `finally` 里**必定**切回普通视图。

纸张常量刻意用 `794/96` × `1123/96` 英寸（CSS 像素 / 96），而**不是**标准 A4 的
8.27×11.69 英寸 —— 否则预览里的分页与导出 PDF 的分页对不上，末尾会多一张空白页。

> ⚠ **命令必须是 `async`。** Tauri 的同步命令跑在主线程上，而 WebView2 的完成回调
> 要靠主线程消息泵派发 —— 在主线程上等回调就是死锁（现象：`export_pdf` 永不返回，
> 连超时文案都打不出来）。现在命令体是
> `tauri::async_runtime::spawn_blocking(move || export::export_pdf(&window, &path)).await`，
> 阻塞等待在 worker 线程上。同理，`with_webview` 闭包里**只发起**打印，不做任何等待。

导出时会给 `html`/`body`/`#root` 注入一层白底（`__re-export-white__`），把**应用外壳**
的底色盖掉；`.doc` 的配色属于 `DesignSpec`，不受影响。

### 4.2 PNG（栅格化）

PDF 出水后用 `pdfjs-dist` 把页面重画进 canvas，再 `toDataURL('image/png')`：

- 单页模式：每页一个 `${base}-01.png`（两位零填充），画完立刻把 canvas 宽高置零释放内存；
- 长图模式：所有页竖着拼进一块画布；
- 守卫：`CANVAS_MAX_SIDE = 65535`、`CANVAS_MAX_AREA = 16384*16384`、
  `PEAK_MEMORY_BUDGET_MB = 800`，超限就拒绝并提示改分辨率/改单页。实测长图上限
  1x/2x/3x 分别是 58 / 29 / 19 页（受限的是高度而不是内存）。

`dist/pdfjs/cmaps`（169 个）与 `dist/pdfjs/standard_fonts`（16 个）必须随包分发 ——
缺了它们中日韩字形会渲染成空白，而且只在含中文的文档上暴露。

## 5. Rust 后端

| 模块 | 内容 |
| --- | --- |
| `lib.rs` | 入口 + 19 个命令的注册；启动顺序（见下） |
| `main.rs` | 转发到 `lib.rs` |
| `logging.rs` | 启动/就绪/退出/崩溃标记，panic hook，日志轮转；崩溃时在 exe 旁写 `启动失败-请看这里.txt` |
| `webview_guard.rs` | 单实例锁；WebView2 profile 自愈（把损坏的 `EBWebView` 挪走） |
| `export.rs` | WebView2 `PrintToPdf` |
| `providers.rs` | 提供商配置（JSON 信封 + keyring 密钥） |
| `history.rs` | 历史记录 6 个命令 |
| `fetch.rs` | 网页抓取 + 正文抽取（绝不把 `<script>` 源码混进正文） |
| `persist.rs` | JSON 读写（UTF-8、原子替换、损坏时给可操作的报错） |
| `llm/` | 协议适配（`chat_completions` / `responses`）、模型探测、生成设计稿 |

### 启动顺序（不可交换）

```
① previous_run_crashed()   先判断「上一次是不是崩了」——必须在 ② 写入本次启动标记之前
② install()                panic hook + 写启动标记
③ claim_single_instance()  第二个实例 → 弹窗 + mark_clean_exit() 后退出
④ prepare_profile(崩过?)   崩过就把 EBWebView 挪走，用干净的 profile
⑤ Builder…run()            setup() 里 mark_ready()；run() 返回后 mark_clean_exit()
```

第 ③ 步里那个 `mark_clean_exit()` 不能省：否则用户双击第二次启动被拒之后，
再启动时会被 ① 误判成「上次崩了」，进而白挪一次 profile。

### 命令清单（19 个）

`keyring_status`、`list_providers`、`save_provider`、`delete_provider`、`delete_providers`、
`provider_has_key`、`fetch_models`、`fetch_models_raw`、`test_provider`、
`generate_design_spec`、`export_pdf`、`export_support`、`fetch_url`，
以及历史的 `list_history`、`add_history`、`get_history`、`delete_history`、
`delete_history_many`、`clear_history`。

Tauri v2 的命令参数默认按 **camelCase** 映射，所以 Rust 的 `api_key: Option<String>`
对应前端的 `apiKey`。

## 6. 存储

| 位置 | 内容 |
| --- | --- |
| `%APPDATA%\com.dsh.resume-embellishment\history.json` | `{"schema_version":1,"entries":[…]}` |
| `%APPDATA%\com.dsh.resume-embellishment\providers.json` | `{"schema_version":1,"providers":[…]}`，只存 `secretRef` |
| `%APPDATA%\com.dsh.resume-embellishment\settings.json` | `plugin-store` 的文件（主题等） |
| Windows 凭据管理器 | API Key 本体（keyring，service = `com.dsh.resume-embellishment`） |
| `%LOCALAPPDATA%\com.dsh.resume-embellishment\EBWebView` | WebView2 user-data 目录 |
| `<exe 同目录>\crash.log` | 启动日志（优先写这里，因为工作区外的 `%APPDATA%` 可能写不进去） |

两个 JSON 都是**带 `schema_version` 的信封**，读的时候同时接受信封和更早的裸数组
（`#[serde(untagged)]`），写的时候一律写信封。

## 7. 样式系统

- Tailwind 4 把颜色编译成 `var(--color-…)`，所以**切主题不动任何调用点**。
- `@theme` 里放的是**深色**的默认值；浅色是一组写在 `@layer` **之外**的
  `[data-theme='light']` 覆盖。未分层的 CSS 优先级高于任何 `@layer`，这样才能稳定
  盖住 Tailwind 的 `@layer theme` token。
- 首帧防闪烁：主题同时写 `localStorage`（同步读）和 `plugin-store`（持久）。
- 字体回退是**逐字形**的，所以 `'Google Sans Flex', 'Noto Sans SC', …` 就能让拉丁走
  Google Sans、中日韩走 Noto Sans SC，不需要任何 JS 参与。

## 8. 构建与交付

`run.mjs`（放在 `Core/` 下，用 Node 直接 spawn 而不经 shell —— 目录名里的 `&`
会让 cmd.exe 把它当命令分隔符）：

| 任务 | 作用 |
| --- | --- |
| `build` | `tsc --noEmit` + `vite build` |
| `app` | 前端 + `cargo build --release --features custom-protocol` + 交付 |
| `deliver` | 只把已构建的 exe/dll 复制到交付目录 |
| `desktop` | 启动桌面版 |
| `rust-test` | `cargo test`（TEMP/TMP 指到 `Core/tmp`，见下） |
| `verify` | 依次跑 `tools/` 里的验收脚本，缺哪个跳过哪个 |

> ⚠ **两个环境坑**
>
> 1. `cargo test` 的临时目录：受限环境下系统 TEMP 不可写，`history.rs` 的测试会以
>    `Os { code: 5 }` 全挂。`run.mjs` 把 `TEMP`/`TMP` 指到 `Core/tmp` 后
>    `68 passed; 0 failed`。测试代码本身没问题。
> 2. **低完整性标签**：如果交付目录（或它的任何祖先）带
>    `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，WebView2 会以
>    `HRESULT(0x800700AA)`（`ERROR_BUSY`，文案「请求的资源在使用中」）创建失败，
>    应用一闪即退 —— 这个错误码**完全误导**，实际没有任何进程占用数据目录。
>    `run.mjs` 的 `healFolder()` 会 `icacls /reset /T` +
>    `icacls /setintegritylevel (OI)(CI)M /T` 修一遍，并把 exe 另镜像一份到
>    工作区**外**的 `Projects\简历美化工具\` 作为保险。

## 9. 验收脚本

| 脚本 | 验的是什么 |
| --- | --- |
| `tools/release-smoke.mjs` | 交付的 exe 真的能起到「启动完成」（判据是日志标记，不是「进程还在」——Tauri 先建窗口后建 webview，webview 挂了窗口也会闪一下） |
| `tools/theme-probe.mjs` | 在真实窗口里量两套主题 token、字体栈与字体是否真的加载、版本标签、主题按钮的循环标签 |
| `tools/desktop-export-check.mjs` | `export_support` / `export_pdf`：打印通路能不能落下合法 PDF，且导出后界面没卡死 |
| `tools/desktop-fetch-check.mjs` | `fetch_url` 的返回结构、正文里没有脚本源码、死地址是**类型化失败** |
| `tools/desktop-history-check.mjs` | 历史 6 个命令的接线与「不存在 = 类型化错误」契约 |
| `tools/verify-png-pipeline.mjs` | PDF → pdfjs → PNG 全链路，并把画布尺寸与源码里的守卫常量对账 |
| `tools/check-fonts.py` | 白名单 19 个字体本机是否真的装了、5 个子集是否完好、两套字体有没有串 |
| `tools/build-fonts.py` | 从源字体重包子集（`--check` 只报告） |

这些脚本共用 `tools/desktop-paths.mjs`（启动、等就绪、CDP 求值、日志读取）。
读取日志一律显式指定 **UTF-8** —— PowerShell 的 `Get-Content -Raw` 会按 GBK 解码，
把中文日志读成乱码，这害过一整轮误判。
