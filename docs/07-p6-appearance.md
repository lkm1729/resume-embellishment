# 07 · P6 外观（主题 / 字体 / 版本 / 图标 / 动效）

这一相位解决的是「毛坯房」问题：功能能用，但面板太暗、字体不统一、没有版本标识、
图标太糙、交互呆板。下面每一条都记了**为什么这么做**，以及验收用的量测值。

---

## A · 主题：浅色面板 + 昼夜切换

### 做法

- Tailwind 4 会把颜色编译成 `var(--color-…)`，所以**切主题不动任何调用点** ——
  组件里照常写 `bg-ink-900 text-ink-200`。
- `@theme` 里放的是**深色**的默认值；浅色是一组写在 `@layer` **之外**的
  `[data-theme='light']` 覆盖块。未分层的 CSS 优先级高于任何 `@layer`，
  这样才能稳定盖住 Tailwind 的 `@layer theme` token。
- 三态：`浅色 / 深色 / 跟随系统`。偏好同时写 `localStorage`（`re.theme`，同步读，
  防首帧闪白）和 `plugin-store`（持久）；只有「跟随系统」时才监听
  `prefers-color-scheme`。
- 切换时给根节点挂 220 ms 的 `.theme-switching`，把过渡打开，切完摘掉 ——
  平时不挂，避免所有交互都被加上 transition。

### token 与实测对比度

**深色色阶（默认）**

| token | 值 | 说明 |
| --- | --- | --- |
| ink-950 | `#12161d` | 画布底 |
| ink-900 | `#181d26` | 面板底 |
| ink-850 | `#1f2530` | 次级面板 |
| ink-800 | `#272e3b` | 分隔/输入框 |
| ink-700 | `#354051` | 边框 |
| ink-600 | `#4b586b` | **弱化**层级（约 2.5:1，故意低于 AA） |
| ink-400 | `#8b96a8` | 次要文字 |
| ink-300 | `#aeb7c4` | 正文 |
| ink-200 | `#d2d9e2` | 强调文字 |

**浅色色阶（覆盖）**

| token | 值 | 白底对比度 |
| --- | --- | --- |
| ink-950 | `#ffffff` | 纸面 |
| ink-900 | `#f8fafc` | 面板底 |
| ink-850 | `#f1f5f9` | 次级面板 |
| ink-800 | `#e2e8f0` | 分隔/输入框 |
| ink-700 | `#cbd5e1` | 边框 |
| ink-600 | `#64748b` | 弱化（4.76:1，刚好过 AA） |
| ink-400 | `#475569` | 次要文字（7.58:1） |
| ink-300 | `#334155` | 正文（10.35:1） |
| ink-200 | `#1e293b` | 强调文字（14.63:1） |

**语义色**

| token | 深色 | 浅色 | 备注 |
| --- | --- | --- | --- |
| canvas | `#12161d` | `#e5e7eb` | 画布（纸面之外的底） |
| brand-500 | `#c9a227` | `#1d4ed8` | 浅色下 6.70:1 |
| warn-500 | `#c9a227` | `#a16207` | 浅色下 5.02:1 |
| danger-500 | `#be123c` | `#be123c` | 两个主题都是 6.29:1 |
| guide | `rgb(201 162 39 / .35)` | `rgb(29 78 216 / .30)` | 对齐参考线 |
| paper-edge | `rgb(0 0 0 / .45)` | `rgb(15 23 42 / .12)` | 纸面描边 |

几处刻意的取舍：

- **`danger-500` 是显式声明的**。原来用 `bg-rose-500 text-white`，深色下只有
  3.67:1；换成 `#be123c` 后两个主题都是 6.29:1。顺带一个坑：Tailwind 会摇掉没被
  用到的 token，所以 `--color-danger-500` 必须显式声明才会被编译出来。
- **金色 `#c9a227` 只能放在深色底上**（对 ink-950 是 7.93:1）；它在白底上只有
  1.60:1，完全不能用。这就是 warn 要拆成两条色阶的原因。
- **浅色下画布 `#e5e7eb` 与白纸只有 1.24:1**，几乎分不出边界，所以纸面加了
  1 px 的 `paper-edge` 环。深色下画布与纸面是 18.13:1，本来就很清楚。
- 这个环**必须用 `box-shadow` 而不是 `border`**：页数是从 `.preview-doc` 的
  `scrollHeight` 推出来的，`border` 会改变盒模型，页数会跟着跳。

**验收值**（`tools/theme-probe.mjs` 在真实窗口里量到的）：

```
浅色  canvas rgb(229,231,235)  ink-900 rgb(248,250,252)  paper-edge rgba(15,23,42,.12)
深色  canvas rgb(18,22,29)     ink-900 rgb(24,29,38)     paper-edge rgba(0,0,0,.45)
主题按钮循环标签：跟随系统 → 浅色 → 深色
```

---

## B · 界面字体：Noto Sans SC + Google Sans Flex

### 做法

- CSS 字体回退是**逐字形**的，所以一条字体栈就够了：
  `'Google Sans Flex', 'Noto Sans SC', 'Microsoft YaHei', -apple-system, …`
  → 拉丁和数字走 Google Sans，中日韩走 Noto Sans SC，**不需要任何 JS 参与**。
- 子集用 Python `fontTools` 生成（`tools/build-fonts.py`），输出 `.woff` 而**不是**
  woff2 —— woff2 要 brotli，本机没有这个模块。
- 两套都是**可变字体**：Google Sans Flex 有六轴
  （`opsz`/`wdth`/`wght`/`GRAD`/`ROND`/`slnt`），Noto Sans SC 有 `wght`（400–900）。
  **必须先 `instantiateVariableFont` 固定到某个字重再子集化**，否则输出的是可变字体。
- 字符集：`NotoSansSC-Regular`（实例化到 wght 400）带 GB2312 一级字库（3755 字）
  + 界面用字；`NotoSansSC-Semibold`（实例化到 wght 600）只带界面用字
  （掉了会回退到 Regular，视觉上可接受）。
- 中文字体原本是 **MiSans**，因为它的自有许可禁止「改编」与「再分发字体组件」，
  子集化 + 内嵌正好同时踩中两条，所以换成了同为无衬线体、但以 OFL 1.1 授权的
  Noto Sans SC。理由与原文摘录见仓库根的 `NOTICE.md`。

### 产物

| 文件 | 体积 | 字形 / 码位 |
| --- | --- | --- |
| `NotoSansSC-Regular.woff` | 1187.1 KB | 4320 / 3891 |
| `NotoSansSC-Semibold.woff` | 392.3 KB | 1687 / 1264 |
| `GoogleSans-400.woff` | 19.4 KB | 262 / 124 |
| `GoogleSans-500.woff` | 20.4 KB | 262 / 124 |
| `GoogleSans-600.woff` | 20.4 KB | 262 / 124 |
| **合计** | **1639.6 KB** | |

换成 Noto Sans SC 之后子集比 MiSans 时代大了约 780 KB（1579.4 KB vs 857.3 KB 的 MiSans
部分）：Noto Sans SC 的轮廓数据更密，同样覆盖 GB2312 一级字库要多花体积。相对 23 MB 的
release 体积可以忽略，换来的是中文渲染在「界面文案 + 一级字库」范围内完全一致，
不会在生僻字上掉回微软雅黑。

**验收值**：`document.fonts` 里 5 个 `@font-face` 全部命中，字体栈实测为
`"Google Sans Flex", "Noto Sans SC", "Microsoft YaHei", …`；64px 下拉丁量得 502.8 px、
中日韩 384.0 px —— 两套字体都在真的生效。

### 授权（重要）

- **两套字体都是 SIL OFL 1.1**，都可以内嵌分发（每一份拷贝都要带上版权声明与许可证原文）。
- **Noto Sans SC** 的版权行是
  `Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'`。
  它派生自 Adobe 的 Source Han Sans，OFL 声明的保留字体名（RFN）是 `Source`；
  我们的子集 family 仍叫 `Noto Sans SC`，没有使用保留名，所以不触发 OFL 条件 3。
- 中文字体原先用的是 **MiSans**，它是小米自有的《MiSans 字体知识产权许可协议》、**不是**
  OFL：既禁止「对字体或其任何单独组件进行改编或二次开发」，也禁止再分发字体组件，
  而「子集化 + 内嵌进构建产物」正好同时踩中这两条 —— 所以换掉了。

  详见仓库根的 [`NOTICE.md`](../NOTICE.md)。

---

## C · 文档字体白名单

**界面字体和文档字体是两套东西。** 导出的简历/求职信只能用
`src/core/design/spec.ts` 里 `FONT_WHITELIST` 的字体 —— 全部是 Windows 自带：

```
Microsoft YaHei, DengXian, SimHei, SimSun, FangSong, KaiTi,
Arial, Calibri, Segoe UI, Verdana, Trebuchet MS, Candara, Georgia,
Times New Roman, Cambria, Garamond, Palatino Linotype, Consolas, Courier New
```

- 原名单有 23 项，其中 11 项在本机**根本没装**，渲染层会**静默**回退到微软雅黑 ——
  用户以为自己在用 Arial，导出来是雅黑。所以名单收窄到 19 项已安装的字体。
- 用户的规则：**生成文档时如果对字体有要求，由用户自己在额外要求里说明，
  否则用系统默认字体。** Noto Sans SC / Google Sans Flex **永远不会**进入这个白名单。
- `tools/check-fonts.py` 会从源码里读这份名单并逐个核对是否真的装了 ——
  名单改了它会跟着变，不会变成一份过期的抄件。

---

## D · 版本号与关于面板

- 构建时由 Vite 注入两个全局量：`__APP_VERSION__`（`package.json` 的 version）与
  `__BUILD_STAMP__`（本地日期 `YYYYMMDD`，可用环境变量 `BUILD_STAMP` 钉住）。
- 标签格式 `V1.0.0 (20261001)` —— 版本号加构建日期，`src/core/ui/version.ts` 负责拼装，
  正则 `^V\d+\.\d+\.\d+ \(\d{8}\)$` 用来验收。
- 位置在侧栏左下角（`src/features/shell/SidebarFooter.tsx`）：左边点开「关于」
  （版本、构建日期、字体致谢），右边是主题切换按钮。

---

## E · 应用图标

- 原图标是一个粗糙的单个「P」。新图标**从旧的 exe 二进制里反解出来**
  （`LoadLibraryExW(LOAD_LIBRARY_AS_DATAFILE)` + `FindResourceW` 取
  `RT_GROUP_ICON=14` / `RT_ICON=3`），`icon.ico` 含 16/24/32/48/64/256 六个尺寸、
  全部 32bpp；PNG 变体用 `System.Drawing.Icon` 逐尺寸导出。
- `tauri.conf.json` 的 `bundle.icon` 引用 `icons/32x32.png`、`icons/128x128.png`、
  `icons/128x128@2x.png`、`icons/icon.ico`。

---

## F · 交互动效

原则：**只做便宜的那种**。全部是 CSS 动画/过渡，不引入动画库，也不碰布局属性。

| 类 | 用途 |
| --- | --- |
| `.theme-switching` | 切主题时临时打开过渡（220 ms 后摘掉） |
| `.card-lift` | 卡片 hover 抬起（`transform` + `box-shadow`） |
| `.stagger-item` | 列表逐项入场，索引上限 12（再多就统一延迟，避免第 50 项要等 3 秒） |
| `.fade-in` / `.fade-in-up` / `.pop-in` | 面板与对话框出现 |
| `.progress-track` | 进度条 |
| `.hint-pulse` | 提示呼吸 |
| 关键帧 | `gradient-flow, aura-rotate, idle-breathe, dash-orbit, fade-in-up, fade-in, pop-in, indeterminate, hint-pulse, spin` |

- **全部动画都受 `prefers-reduced-motion` 保护**，系统开了减弱动效就全关。
- 刻意**不做**：背景粒子、3D 倾斜、滚动视差、自定义光标 —— 这些要么吃性能，
  要么会干扰用户读自己的简历。

**验收**：`tools/theme-probe.mjs` 会真的点三次主题按钮并核对标签循环；
`release-smoke.mjs` 确认交付的 exe 能起到「启动完成」。
