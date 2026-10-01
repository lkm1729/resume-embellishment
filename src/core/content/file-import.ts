/**
 * 参考资料的文件导入：按格式分派到对应的抽取器。
 *
 * 单独成文件而不是写在组件里，是为了**能被测试**。
 * 组件里的分支逻辑（尤其是错误提示）最容易随时间腐化 ——
 * 加了新格式却忘了改提示文案，用户看到的就会是错的说明。
 */

import { extractDocxText } from './docx-import';
import { extractPdfText } from './pdf-import';

/** 已支持的导入格式。 */
export type FileKind = 'text' | 'pdf' | 'docx' | 'doc-legacy' | 'unknown';

/** 该格式的展示名，用于提示文案。 */
export const KIND_LABELS: Record<FileKind, string> = {
  text: '纯文本',
  pdf: 'PDF',
  docx: 'Word（.docx）',
  'doc-legacy': '旧版 Word（.doc）',
  unknown: '未知格式',
};

/** 导入结果。 */
export interface ImportResult {
  text: string;
  /** 需要让用户知道的警告（如 PDF 可能是扫描件但仍有少量文字）。 */
  warning?: string;
}

/**
 * 按扩展名判断格式。
 *
 * 优先看扩展名而不是 MIME：浏览器给 .md / .docx 的 type 经常是空串
 * 或不准确的 `application/octet-stream`，而扩展名是用户和系统都认的。
 * MIME 只在扩展名缺失时作兜底。
 */
export function detectFileKind(file: { name: string; type?: string }): FileKind {
  const name = file.name.toLowerCase();
  const type = (file.type ?? '').toLowerCase();

  if (/\.(txt|text|md|markdown)$/.test(name)) return 'text';
  if (/\.pdf$/.test(name)) return 'pdf';
  if (/\.docx$/.test(name)) return 'docx';
  // .doc 是二进制复合格式，与 .docx 完全不是一回事，不能假装能读
  if (/\.doc$/.test(name)) return 'doc-legacy';

  if (type.startsWith('text/')) return 'text';
  if (type === 'application/pdf') return 'pdf';

  return 'unknown';
}

/**
 * 读取一个文件并抽出纯文本。
 *
 * @throws {Error} 消息可直接展示给用户 —— 调用方不再包装
 */
export async function readReferenceFile(
  file: File,
  kind: FileKind = detectFileKind(file),
): Promise<ImportResult> {
  switch (kind) {
    case 'text': {
      const text = await file.text();
      return { text };
    }

    case 'pdf': {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = await extractPdfText(bytes);
      return { text };
    }

    case 'docx': {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = await extractDocxText(bytes);
      return { text };
    }

    case 'doc-legacy':
      throw new Error(
        '是旧版 .doc 格式，读不了。请在 Word 里「另存为 .docx」后再导入。',
      );

    case 'unknown':
    default:
      throw new Error(
        '格式不支持。目前可以导入 .txt / .md / .pdf / .docx，' +
          '其他格式请直接把文字粘贴进来。',
      );
  }
}

/** `<input accept>` 用的值，与上面的判断保持一致。 */
export const ACCEPT_ATTR =
  '.txt,.text,.md,.markdown,.pdf,.docx,text/plain,text/markdown,application/pdf';
