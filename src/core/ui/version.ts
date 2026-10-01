/**
 * 版本信息。
 *
 * 显示形如 `V0.1.0(20260928)`：版本号取自 package.json，
 * 日期是**构建日期**，都由 Vite 在构建时注入。
 *
 * 为什么不用 Tauri 的 `getVersion()`：
 * 它能在运行时拿到 tauri.conf.json 的版本号，但**拿不到构建日期** ——
 * 日期必须在构建时固化，运行时无从得知（运行时只能知道"现在"）。
 * 既然日期非要构建期注入不可，版本号就顺手从同一条路径取，
 * 免得两个数字来自两个来源。
 *
 * 三处版本号（package.json / tauri.conf.json / Cargo.toml）
 * 的一致性由 version.test.ts 守着。
 */

/** 语义化版本号，来自 package.json。 */
export const APP_VERSION = __APP_VERSION__;

/** 构建日期，YYYYMMDD。 */
export const BUILD_STAMP = __BUILD_STAMP__;

/** 展示用字符串：`V0.1.1 (20260930)`。 */
export const VERSION_LABEL = `V${APP_VERSION} (${BUILD_STAMP})`;

/** 把 YYYYMMDD 变成 `2026-09-28`，用于「关于」面板里更好读的位置。 */
export function prettyStamp(stamp: string = BUILD_STAMP): string {
  if (!/^\d{8}$/.test(stamp)) return stamp;
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
}

/**
 * 第三方字体署名。
 *
 * **这不是可选项**：SIL OFL 1.1 要求每一份拷贝都带上版权声明与许可证原文，
 * 所以「关于」面板与仓库根的 `NOTICE.md` 都必须列出这两套界面字体。
 * 界面字体（Noto Sans SC / Google Sans Flex）与导出文档用的 `FONT_WHITELIST` 无关。
 */
export const FONT_CREDITS = [
  {
    name: 'Noto Sans SC',
    holder: 'The Noto Project Authors',
    license: 'SIL Open Font License 1.1',
    note: '界面中文字面。本项目只做子集化裁剪，未使用保留字体名（RFN 为 “Source”）。',
    url: 'https://fonts.google.com/noto/specimen/Noto+Sans+SC',
  },
  {
    name: 'Google Sans Flex',
    holder: 'The Google Sans Project Authors',
    license: 'SIL Open Font License 1.1',
    note: '仅用于界面拉丁字母与数字；汉字的字面来自 Noto Sans SC。',
    url: 'https://fonts.google.com/specimen/Google+Sans',
  },
] as const;
