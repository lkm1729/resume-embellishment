/**
 * 把预览里的文档送到 Google Docs。
 *
 * 走的是和「导出 Word」完全相同的一条渲染通路（`buildDocx`），
 * 只是产物不落盘而是直接上传 —— 所以 Google 那边看到的东西
 * 和用户刚才在预览里看到的是同一份。
 *
 * ⚠ 因此 Word 侧那两个保真缺口在这里同样成立，而且在这里**更值得说清**：
 * 分栏板块会变成单栏，`emphasis` / 圆角 / 强调条也不还原。
 * 界面上的说明文字与 Word 按钮共用一套（见 ExportButtons 的 `multiColumn`）。
 */

import type { ContentUnit } from '@/core/content/types';
import type { DesignSpec } from '@/core/design/spec';
import { uploadGoogleDocx, type GoogleDoc } from './api';

/**
 * 字节转 base64。
 *
 * 分块是必须的：`String.fromCharCode(...bytes)` 一次性展开几十万个参数
 * 会直接爆栈（引擎对参数个数有上限），而一份带图的 docx 很容易到这个量级。
 * 0x8000 是常见的折中值 —— 远低于上限，又不必切太多刀。
 *
 * 导出只是为了测试：这一段的输出必须和 Rust 侧 `BASE64_STANDARD`
 * 的期望完全一致，错一个字符那边就报「这份 Word 数据读不出来」。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 生成 .docx 并上传，返回 Google 文档的地址。
 *
 * `docx` 库动态引入：它只在真的要导出 Word 时才会被下载执行，
 * 而不是压在首屏包里（导出通路本来就是这个写法）。
 */
export async function syncToGoogleDocs(opts: {
  units: readonly ContentUnit[];
  spec: DesignSpec;
  /** 文件名主体，不带扩展名。Rust 侧会把 `.docx` 兜底剥掉，这里也先剥一遍。 */
  baseName: string;
}): Promise<GoogleDoc> {
  const { buildDocx } = await import('@/core/export/docx');
  const blob = await buildDocx(opts.units, opts.spec);
  const base64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  return uploadGoogleDocx(opts.baseName, base64);
}
