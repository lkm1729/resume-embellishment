# 简历与求职信美化

> 把你的简历/求职信排得好看 —— **只改版式，不改文字**。

一个 Windows 桌面应用。你把自己的简历或求职信正文粘进去，它用你自备的大模型 API
生成一套视觉设计（配色、字体、分栏、层级），渲染成 HTML 后导出 PDF / PNG / Word，
或者直接同步到你的 Google Docs。

**核心承诺：它永远不会改动你写的字。** 这不是靠提示词约束或者事后检查，而是类型系统
保证的 —— 详见下面的[为什么它改不了你的正文](#为什么它改不了你的正文)。

---

## 目录

- [主要功能](#主要功能)
- [下载](#下载)
- [如何安装和使用](#如何安装和使用)
- [隐私与数据](#隐私与数据)
- [为什么它改不了你的正文](#为什么它改不了你的正文)
- [从源码构建](#从源码构建)
- [项目结构](#项目结构)
- [许可证](#许可证)

---

## 主要功能

**四种输出方式**

- **PDF（矢量）** —— 走 WebView2 打印管线，文字可选中、可搜索。
- **PNG（长图）** —— 用 pdfjs 栅格化，适合直接发出去。内置画布尺寸与内存守卫，
  超长简历会提前拦下来而不是把渲染进程搞崩。
- **Word（.docx）** —— 用 `docx` 库直接构建，便于对方在线批注修改。
  保真度是**近似还原**：字体、字号层级、配色、间距会带过去，
  但多栏版式会变成单栏。
- **同步到 Google Docs** —— 走 OAuth（PKCE + 回环重定向），把 `.docx` 上传到
  你自己的 Google Drive 并由 Google 转换成 Google 文档，然后在浏览器里打开。

**版式生成**

- 从你粘贴的正文里切分出结构（标题、小节、条目），交给大模型产出**纯样式**设计稿。
- 支持**两种接口协议**：`Chat Completions`（兼容性最广）与 `Responses`（OpenAI 新协议）。
- **能力探测与降级阶梯**：结构化输出依次尝试 `json_schema` → `json_object` → 纯文本，
  端点不支持哪一层就自动退到下一层，而不是直接失败。
- **模型设置**：每个模型可单独配置温度、思考强度
  （`none` / `low` / `medium` / `high` / `xhigh` / `max`）、
  是否支持结构化输出、是否支持多模态（图片）。留空即自动跟随探测结果。

**输入**

- 粘贴纯文本，或导入 **PDF / DOCX / 图片 / 文本** 文件（图片走多模态通道）。
- 抓取**网页 URL** 正文，自动抽取正文内容。
- 剪贴板**粘贴图片**。
- **目标岗位资料**与**额外补充资料**可以分别填写，也可以逐条指定角色。

**排版与字体**

- **视觉风格**：内置风格预设，也可以直接写自定义风格要求。
- **自定义字体**：直接读取你**这台电脑上已安装的字体**（Windows GDI 枚举），
  标题字体与正文字体可以分别指定。留空则跟随版式 —— 也就是模型挑的那一对。
- 可选的**继续调整**：在已生成的版式上继续对话式微调，并保留**退回上一版版式**的能力。

**其它**

- **历史记录**：本地保存每次生成，可回滚、可删除，回滚不需要重新调用模型。
- **深浅色主题**：浅色 / 深色 / 跟随系统。
- 生成完成后会在预览面板顶部与生成按钮下方同时给出提示：生成时间、供应商、模型名、协议。

---

## 下载

去 [Releases](../../releases) 页面下载最新的 ZIP：

| 文件 | 说明 |
| --- | --- |
| `Resume-Embellishment-1.0.0-win-x64.zip` | 免安装绿色版，解压即用 |
| `SHA256SUMS.txt` | 校验和 |

系统要求：**Windows 10 / 11 64 位**，需要 **WebView2 运行时**
（Win11 与较新的 Win10 已预装；没有的话装一下
[Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)）。

---

## 如何安装和使用

**安装**

1. 下载 `Resume-Embellishment-1.0.0-win-x64.zip`。
2. **解压到一个普通文件夹**（比如 `D:\Apps\ResumeEmbellishment`）。
   不要直接在压缩包里双击运行 —— 程序会在自己旁边写日志，只读目录会出问题。
3. 双击 `ResumeEmbellishment.exe`。

> 建议解压到**不带空格、不带 `&` 等特殊字符**的路径。这不是本程序的限制，
> 而是 Windows 上一些工具链的常见坑。

**第一次使用**

1. 打开左侧的 **模型供应商** 标签页，添加一个供应商：
   - 填 **Base URL**（比如 `https://api.openai.com/v1`）；
   - 选 **协议**（不确定就选 Chat Completions）；
   - 填 **API Key**；
   - 点 **测试连接**，再点 **拉取模型列表**，勾选你要用的模型。
2. 回到 **简历美化** 标签页，把你的简历正文粘进去，按需补充目标岗位资料。
3. 点 **生成版式**。生成完成后右侧预览就是成品效果。
4. 用预览面板下方的按钮导出 PDF / PNG / Word，或者同步到 Google Docs。

**关于 Google Docs 同步**

首次使用需要做一次性的 OAuth 客户端配置（之后永久免配置）：

1. 在 **Google Cloud Console** 里创建一个项目，启用 **Google Drive API**。
2. 配置 OAuth 同意屏幕（选 **外部**，把自己加为测试用户即可）。
3. 创建凭据，类型选 **桌面应用（Desktop app）**，拿到 Client ID 与 Client Secret。
4. 把这两个值粘进应用里的配置向导。

只申请 `drive.file` 权限 —— 这是 Google 分类里的**非敏感权限**，应用只能看到
**它自己创建的文件**，看不到你 Drive 里的其它任何东西，也不需要 Google 审核。

---

## 隐私与数据

**你的简历正文、生成的记录、供应商配置，全部只存在你自己电脑上。** 本程序没有
任何自建服务器，也不会上报任何使用数据。

数据位置：

| 内容 | 路径 |
| --- | --- |
| 供应商配置、历史记录、界面设置 | `%APPDATA%\com.dsh.resume-embellishment\` |
| WebView2 缓存 | `%LOCALAPPDATA%\com.dsh.resume-embellishment\` |
| API Key、Google OAuth 凭据 | **Windows 凭据管理器**（不落盘成文件） |

**API Key 的处理**：密钥存在 Windows 凭据管理器里，**永远不会**进入前端状态、
日志或 JSON 配置文件。`src/core/llm/types.ts` 里的 `Provider` 类型刻意没有
`apiKey` 字段 —— 这不是遗漏。

**唯一的对外网络请求**是：① 你配置的模型 API 端点；② 你主动使用的网页抓取；
③ 你主动触发的 Google Drive 上传。除此之外没有任何遥测。

---

## 为什么它改不了你的正文

这是整个项目最硬的一条不变量：

```
ContentUnit { id, kind, text, level? }              ← 你的原文，只在这里
DesignSpec  { …样式…, blocks: [{ contentId, … }] }   ← 模型只能产出样式
```

**`DesignSpec` 里没有任何字段可以承载正文文字，它只能引用 `contentId`。**
模型拿不到写正文的位置，只能给已有的 `contentId` 指定样式；渲染器再从
`ContentUnit[]` 里按 id 取回原文拼进 HTML，任何未知 `contentId` 都会被忽略。

所以「模型会不会偷偷改我的话」不是靠事后校验，而是**类型系统**保证的。

另外，渲染层 `(ContentUnit[], DesignSpec) → HTML` 是一个**纯函数**，
预览面板、PDF 导出、历史回滚三者喂的是同一份输入 ——
所以「预览看到什么，导出就是什么」是结构上成立的，而不是靠维护两套模板。

设计稿本身用 zod 校验，字体字段是一个**封闭枚举**（只允许系统自带字体），
所以模型也没法往样式里塞任何自由文本。用户自选的字体走的是独立的覆盖层，
刻意绕开这个枚举 —— 它只流向渲染与导出，不回存、不发给模型。

---

## 从源码构建

**前置要求**

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) 稳定版（MSVC 工具链）
- Visual Studio Build Tools（C++ 生成工具）

**构建**

```powershell
cd resume-embellishment

npm install

# 开发模式（热重载）
npm run tauri dev

# 生产构建
node run.mjs app
```

> 构建入口是 `run.mjs` 而不是 `npm run tauri build`。它绕过 npm 与 shell 直接
> spawn 子进程，因为工程目录名历史上含 `&`，在 `cmd.exe` 下会被当成命令分隔符。
> 它还会处理一件事：给输出目录重置完整性标签，否则 WebView2 在低完整性目录下
> 起不来，宿主进程会以 `HRESULT(0x800700AA)` 失败。

**测试**

```powershell
# 前端（vitest）
npm test

# 类型检查
npm run typecheck

# Rust
cargo test --manifest-path src-tauri/Cargo.toml
```

**`run.mjs` 的其它任务**

| 命令 | 作用 |
| --- | --- |
| `node run.mjs app` | 完整构建并交付（前端 + Rust release + 复制产物） |
| `node run.mjs frontend` | 只跑 tsc + vite |
| `node run.mjs deliver` | 只复制已构建的产物 |
| `node run.mjs desktop` | 构建并启动 |
| `node run.mjs rust-test` | 跑 Rust 测试 |
| `node run.mjs verify` | 跑桌面对抗性检查脚本 |

---

## 项目结构

```
resume-embellishment/
├── src/                        前端（React 19 + TypeScript + Vite）
│   ├── app/                    应用外壳与入口
│   ├── assets/fonts/           界面字体子集（随包发布）
│   ├── components/             通用组件
│   ├── core/                   与界面无关的核心逻辑
│   │   ├── content/            解析文本 / PDF / DOCX / 图片 → ContentUnit[]
│   │   ├── design/             DesignSpec 类型、zod 校验、生成编排
│   │   ├── export/             PDF / PNG / DOCX 导出与画布守卫
│   │   ├── fonts/              本机字体枚举与字体覆盖层
│   │   ├── google/             Google Docs 同步
│   │   ├── history/            本地历史记录
│   │   ├── llm/                供应商配置、协议、能力探测
│   │   ├── render/             纯函数 (ContentUnit[], DesignSpec) → HTML
│   │   ├── store/              zustand 状态
│   │   └── ui/                 主题与版本标签
│   └── features/               界面功能模块
│       ├── design/             生成按钮与状态
│       ├── editor/             左侧编辑器各方块
│       ├── google/             Google Docs 同步界面
│       ├── history/            历史面板
│       ├── preview/            预览与导出按钮
│       ├── providers/          供应商与模型设置
│       └── shell/              外壳与侧边栏
├── src-tauri/                  Rust 后端（Tauri 2）
│   └── src/
│       ├── llm/                请求构建、协议适配、降级阶梯
│       ├── export.rs           PDF 打印
│       ├── fetch.rs            网页抓取与正文抽取
│       ├── fonts.rs            系统字体枚举（GDI）
│       ├── google.rs           OAuth（PKCE）与 Drive 上传
│       ├── history.rs          历史记录持久化
│       ├── providers.rs        供应商配置
│       ├── secrets.rs          Windows 凭据管理器
│       └── logging.rs          日志与崩溃记录
├── docs/                       架构文档
├── tools/                      字体子集化与桌面对抗性检查脚本
├── NOTICE.md                   字体授权与第三方组件声明
└── run.mjs                     构建入口
```

架构细节见 [`docs/00-architecture.md`](docs/00-architecture.md)。

---

## 许可证

本项目以 **MIT** 协议开源，见 [LICENSE](LICENSE)。

界面字体（Noto Sans SC 与 Google Sans Flex）以 **SIL Open Font License 1.1** 授权，
第三方组件的授权与完整协议正文见 [NOTICE.md](NOTICE.md)。
