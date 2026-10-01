# NOTICE — 字体与第三方组件声明

本文件说明「简历与求职信美化」使用的字体授权与第三方组件。两套界面字体
（Noto Sans SC 与 Google Sans Flex）都以 SIL Open Font License 1.1 授权，
本文件与软件内「关于」面板共同履行 OFL 要求的「每份拷贝都带上版权声明与许可证原文」。

---

## 1. Noto Sans SC（中文界面字体）

**本软件使用了 Noto Sans SC 字体。** 它以 SIL Open Font License 1.1 授权。

Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'

`src/assets/fonts/` 下的 `NotoSansSC-Regular.woff` 与 `NotoSansSC-Semibold.woff` 是为界面
排版而做的**子集化产物**：

- 上游仓库：<https://github.com/google/fonts/tree/main/ofl/notosanssc>
- 源字体：`ofl/notosanssc/NotoSansSC[wght].ttf`（wght 可变字体，先实例化成 400 / 600 再子集化）
- 许可证原文：<https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt>
- 完整的 OFL 1.1 正文见本文件第 2 节（两套界面字体共用同一份协议文本）

关于保留字体名（OFL 条件 3）：Noto Sans SC 派生自 Adobe 的 Source Han Sans，OFL 声明的
保留字体名（RFN）是 `Source`。本项目只做子集化裁剪、没有把 family 改成任何含 `Source`
的名字，子集仍然叫 `Noto Sans SC`，因此不触发保留名限制。

### 为什么中文字体不是 MiSans

本项目早期版本内嵌的中文字体是 **MiSans**。它不是 OFL 字体，而是小米科技有限责任公司
（Xiaomi Inc.）自有的《MiSans 字体知识产权许可协议》，其中两条与「把字体子集内嵌进
可分发产物」直接冲突：

- 条件 2：「您不得对 MiSans 字体或其任何单独组件进行改编或二次开发。」—— 子集化即改编；
- 条件 3：「您不得单独将 MiSans 字体或其组件对外租赁、再许可、给予、出借或进一步分发
  字体软件或其任何副本以及重新分发或售卖。」—— 内嵌字体文件属于分发字体组件，而该条的
  豁免（「使用 MiSans 字体创作的宣传素材、logo、应用 App 等」）并未明确覆盖内嵌的字体
  文件本身。

所以在维护者拍板后，界面中文字体换成了同为无衬线体、但以 OFL 1.1 授权的 **Noto Sans SC**；
拉丁字母与数字继续使用 **Google Sans Flex**（同样 OFL）。MiSans 的子集文件已从
`src/assets/fonts/` 移除。

> 注意：界面字体与**文档字体**是两套东西。导出简历/求职信时使用的字体始终来自
> `FONT_WHITELIST`（仅 Windows 自带字体），Noto Sans SC 与 Google Sans Flex
> **永远不进入**该白名单。

---

## 2. Google Sans Flex（拉丁字母与数字界面字体）

`src/assets/fonts/` 下的 `GoogleSans-400.woff`、`GoogleSans-500.woff`、
`GoogleSans-600.woff` 是 Google Sans Flex 的子集，以 SIL Open Font License 1.1 授权。

Copyright 2022 The Google Sans Flex Project Authors (github.com/googlefonts/googlesans-flex)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.

---

## 3. 第三方组件

本项目为桌面应用，运行时依赖以下开源组件（各自遵循其自身许可）：

| 组件 | 许可 |
| --- | --- |
| Tauri（`tauri`、`tauri-build`、`tauri-plugin-*`） | MIT / Apache-2.0 |
| React、React DOM | MIT |
| zustand | MIT |
| zod | MIT |
| pdfjs-dist | Apache-2.0 |
| docx | MIT |
| marked | MIT |
| lucide-react | ISC |
| Tailwind CSS | MIT |
| Vite、Vitest | MIT |
| TypeScript | Apache-2.0 |
| WebView2 Runtime（Microsoft，系统组件，未随包分发） | Microsoft 软件许可条款 |

完整依赖树与版本见 `package.json`、`package-lock.json` 与 `src-tauri/Cargo.lock`。

---

## 4. 关于生成文档中的字体

用户在应用内生成的简历 / 求职信，其字体由**文档字体白名单**（`src/core/design/spec.ts`
中的 `FONT_WHITELIST`）限定，只包含 Windows 自带字体（微软雅黑、等线、黑体、宋体、
Arial、Calibri、Times New Roman 等）。界面所用的 Noto Sans SC / Google Sans Flex
**不会**出现在导出文档中，因此它们只影响应用外壳的观感。
