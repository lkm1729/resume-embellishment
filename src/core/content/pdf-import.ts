/**
 * PDF 正文抽取。
 *
 * ═══════════════════════════════════════════════════════════════
 *  与 DOCX 抽取同样的目标：**宁可漏掉修饰，不可丢掉文字**。
 *
 *  但 PDF 比 DOCX 难，因为它根本没有"段落"这个概念 ——
 *  页面里只有一个个被放置在坐标上的文字片段。
 *  段落、换行、列，都是**我们从坐标里推断出来的**。
 *
 *  所以这里分两层：
 *    · `assemblePage()` / `assemblePdf()` —— 纯函数，从坐标还原行与段
 *    · `extractPdfText()` —— 负责调用 pdfjs 把 PDF 变成坐标数据
 *  前者是真正容易出错、也最需要测试的部分，因此它完全不依赖 pdfjs。
 * ═══════════════════════════════════════════════════════════════
 */

/** pdfjs 文字片段里我们需要的字段。 */
export interface PdfTextItem {
  str: string;
  /** 变换矩阵 [a,b,c,d,e,f]，其中 e 是 x、f 是 y（PDF 坐标，原点在左下）。 */
  transform: number[];
  width: number;
  height: number;
  /** pdfjs 判断该片段是该行最后一个时的标记。 */
  hasEOL?: boolean;
}

/** 抽取失败时抛出，消息可直接展示给用户。 */
export class PdfImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfImportError';
  }
}

/** 一页的文字与尺寸。 */
export interface PdfPage {
  items: PdfTextItem[];
  width: number;
  height: number;
}

/** 判定"同一个视觉行"的纵向容差（PDF 单位，约 1/72 英寸）。 */
const LINE_TOLERANCE = 2.5;
/**
 * 判定"这里视觉上是个空格"的横向间隙阈值，单位是**字号的比例（em）**。
 *
 * 定这个数的依据：
 *   · 真正的空格字符通常在 `str` 里就已经带出来了，
 *     所以我们在坐标上看到的大多只有两种情形：
 *   · **字距微调造成的碎片**：间隙通常 < 0.1 em（如 "Type" 与 "Script" 之间）。
 *   · **字段分隔**（姓名 | 职位 | 日期，或表格列）：间隙通常 > 0.5 em。
 *
 * 0.25 em 落在两者中间，且与真实空格宽度（约 0.25–0.35 em）相当，
 * 因此既能合并被拆碎的单词，也能还原被分开的字段。
 */
const SPACE_GAP_EM = 0.25;

/** 取片段的基线 y。 */
function itemY(it: PdfTextItem): number {
  return it.transform[5] ?? 0;
}

/** 取片段的起始 x。 */
function itemX(it: PdfTextItem): number {
  return it.transform[4] ?? 0;
}

/**
 * 估算片段所属的**字号**，用作间隙阈值的基准。
 *
 * 优先用 `height`（pdfjs 直接给出的字体高度）。
 * 它缺失或异常时退化用"平均字宽 × 1.6" ——
 * 对正文字体来说字高约为字宽的 1.4–1.8 倍，这个近似足够。
 */
function fontSize(it: PdfTextItem): number {
  if (Number.isFinite(it.height) && it.height > 0) return it.height;
  const n = it.str.length;
  if (n > 0 && Number.isFinite(it.width) && it.width > 0) return (it.width / n) * 1.6;
  return 6; // 兜底：典型正文字号的一半，宁可保守
}

/**
 * 把一页的文字片段还原成若干行。
 *
 * 算法：按 y 聚类成行 → 行内按 x 排序 → 按间距决定是否补空格。
 *
 * 为什么不用 `hasEOL` 直接切行：
 * 它并不总是可靠（有些生成器不写），而且它只标记"这里该换行"，
 * 不告诉你同一行里哪些片段属于一起。坐标才是唯一的事实来源。
 */
export function assemblePage(page: PdfPage): string[] {
  // 丢掉空片段（pdfjs 会把纯空白也返回）
  const items = page.items.filter((it) => it.str.length > 0);
  if (items.length === 0) return [];

  // 按 y 从大到小（PDF 原点在左下，y 大在上），同 y 按 x 从小到大
  const sorted = [...items].sort((a, b) => {
    const dy = itemY(b) - itemY(a);
    if (Math.abs(dy) > LINE_TOLERANCE) return dy;
    return itemX(a) - itemX(b);
  });

  const lines: PdfTextItem[][] = [];
  let current: PdfTextItem[] = [];
  let currentY: number | null = null;

  for (const it of sorted) {
    const y = itemY(it);
    if (currentY === null) {
      currentY = y;
      current = [it];
      continue;
    }
    if (Math.abs(y - currentY) <= LINE_TOLERANCE) {
      current.push(it);
    } else {
      lines.push(current);
      current = [it];
      currentY = y;
    }
  }
  if (current.length > 0) lines.push(current);

  return lines.map(joinLine);
}

/** 把同一行里的片段拼成一个字符串，按间距补空格。 */
function joinLine(line: PdfTextItem[]): string {
  const parts = [...line].sort((a, b) => itemX(a) - itemX(b));
  let out = '';

  for (let i = 0; i < parts.length; i++) {
    const it = parts[i];
    if (!it) continue;

    if (i > 0) {
      const prev = parts[i - 1];
      if (prev) {
        const prevEnd = itemX(prev) + prev.width;
        const gap = itemX(it) - prevEnd;
        // 阈值以**字号**为基准而不是字宽：字宽会随字母宽度剧烈变化
        // （"i" 与 "W" 差好几倍），用字宽算阈值会让判断忽紧忽松。
        const threshold = Math.max(fontSize(prev), fontSize(it)) * SPACE_GAP_EM;
        if (gap > threshold && !out.endsWith(' ') && !it.str.startsWith(' ')) {
          out += ' ';
        }
      }
    }
    out += it.str;

    // pdfjs 明确标记了行尾时尊重它
    if (it.hasEOL && i < parts.length - 1) out += '\n';
  }

  return out;
}

/**
 * 把若干页的文字合成整篇正文。
 *
 * 页与页之间用一个空行分隔 —— PDF 的分页往往正好落在段落边界上，
 * 用空行能让后续的板块识别更准。但**不**试图判断"上一页末尾与
 * 下一页开头是不是同一句话"：那是猜测，猜错就是改字。
 */
export function assemblePdf(pages: readonly PdfPage[]): string {
  const blocks: string[] = [];
  for (const page of pages) {
    const lines = assemblePage(page);
    // 页内：把行合并，行尾空白去掉；连续空行压成一个
    const cleaned: string[] = [];
    for (const line of lines) {
      for (const piece of line.split('\n')) {
        const t = piece.replace(/[ \t]+$/g, '');
        cleaned.push(t);
      }
    }
    blocks.push(trimBlankEdges(cleaned).join('\n'));
  }

  return blocks
    .filter((b) => b.trim().length > 0)
    .join('\n\n')
    .trim();
}

/** 去掉数组首尾的空行。 */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim().length === 0) start++;
  while (end > start && (lines[end - 1] ?? '').trim().length === 0) end--;
  return lines.slice(start, end);
}

/**
 * 判断抽取结果是否**很可能是乱码**。
 *
 * 为什么需要这个：
 * 有些 PDF 没嵌入字体、也没有 ToUnicode 映射表，只能靠预定义 CMap 反查。
 * 我们不带 CMap 资源（那会让安装包大一截），于是这些文件会解出
 * 一堆替换字符或私用区字符。
 *
 * **宁可明确报错，也不能把乱码当成用户的简历喂进去** ——
 * 乱码会在后续环节被当作正常文字排版、导出，
 * 用户很可能到"下载了 PDF 打开一看"才发现，那就太晚了。
 *
 * 判据（宽松，只抓明显的乱码）：
 *   · 替换字符 U+FFFD 占比高
 *   · 私用区（U+E000–U+F8FF）字符占比高
 *   · 可见字符总数极少（扫描件）
 */
export function looksLikeGarbage(text: string): { garbage: boolean; reason?: string } {
  const chars = [...text].filter((c) => c.trim().length > 0);
  if (chars.length === 0) {
    return { garbage: true, reason: 'empty' };
  }

  let bad = 0;
  for (const c of chars) {
    const cp = c.codePointAt(0) ?? 0;
    if (c === '\ufffd') bad++;
    else if (cp >= 0xe000 && cp <= 0xf8ff) bad++;
  }

  // 阈值取 30%：正常的 PDF 里这几个字符几乎不该出现，
  // 留出余量是为了不误伤确实包含私用区图标字体的文件。
  if (bad / chars.length > 0.3) {
    return { garbage: true, reason: 'encoding' };
  }

  return { garbage: false };
}

/**
 * pdfjs 模块的最小接口，便于测试注入。
 *
 * 注意 `GlobalWorkerOptions` 也要在接口里 —— 设置 worker 路径是
 * **必须**的一步，漏掉它 pdfjs 会直接抛
 * `No "GlobalWorkerOptions.workerSrc" specified`，
 * 而这只有在浏览器里才会暴露（Node 下走 legacy 构建不需要 worker）。
 */
export interface PdfjsLike {
  GlobalWorkerOptions?: { workerSrc: string };
  getDocument(src: Record<string, unknown>): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getViewport(o: { scale: number }): { width: number; height: number };
        getTextContent(): Promise<{ items: unknown[] }>;
      }>;
    }>;
  };
}

/** 抽取时可调的外部资源。 */
export interface PdfExtractDeps {
  /** 注入 pdfjs 模块（测试用）。不传则按运行环境自动加载。 */
  pdfjs?: PdfjsLike;
}

/**
 * 按运行环境加载 pdfjs。
 *
 * pdfjs v6 的主构建**跑不了 Node**（依赖 `Uint8Array.prototype.toHex`），
 * 官方为此提供了 legacy 构建。单元测试跑在 Node 里，因此必须分环境加载 ——
 * 否则测试要么跑不起来，要么得把整个抽取逻辑 mock 掉（那就等于没测）。
 *
 * 浏览器环境还要额外设置 worker：pdfjs 把解析放在 worker 线程里，
 * 不指定 `workerSrc` 会直接抛错（Node 的 legacy 构建是同步解析，不需要）。
 * worker 脚本用打包进来的那份，避免运行时去网上取 ——
 * 桌面应用可能完全离线。
 */
async function loadPdfjs(): Promise<PdfjsLike> {
  const isNode =
    typeof process !== 'undefined' &&
    !!process.versions?.node &&
    typeof window === 'undefined';

  if (isNode) {
    return (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsLike;
  }

  const pdfjs = (await import('pdfjs-dist')) as unknown as PdfjsLike;
  if (pdfjs.GlobalWorkerOptions) {
    // `?url` 让打包器把它当作资源并返回真实 URL，同时把文件复制进产物
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  return pdfjs;
}

/**
 * pdfjs 辅助资源的位置。
 *
 * 这两个目录由 `run.mjs` 在 dev/build 前从 node_modules 同步到 `public/pdfjs/`，
 * 因此运行时它们与 index.html 同级。
 *
 * 为什么需要它们：中文 PDF 常用**预定义 CMap**（不内嵌 ToUnicode 表）。
 * 没有 cmaps 就只能解出乱码；没有 standard_fonts，未内嵌的
 * 标准字体（pdfjs 用 Foxit/Liberation 替代）无法度量，会影响
 * 文字宽度推断。缺了不会报错，只会**静默降级** —— 所以必须显式给上。
 */
function assetUrls(): { cMapUrl: string; standardFontDataUrl: string } {
  const base =
    typeof window !== 'undefined' && window.location
      ? new URL('pdfjs/', window.location.href).href
      : '';
  if (!base) {
    // Node（测试）环境：测试用的 PDF 是自建的单行英文文件，
    // 不需要 CMap。给空串会让 pdfjs 去找相对路径并打警告，
    // 因此这里显式不传，由调用方按需省略。
    return { cMapUrl: '', standardFontDataUrl: '' };
  }
  return {
    cMapUrl: `${base}cmaps/`,
    standardFontDataUrl: `${base}standard_fonts/`,
  };
}

/**
 * 从一个 PDF 字节流抽取纯文本。
 *
 * @throws {PdfImportError} 需要密码、文件损坏、或抽出来是乱码/空
 */
export async function extractPdfText(
  bytes: Uint8Array,
  deps: PdfExtractDeps = {},
): Promise<string> {
  const pdfjs = deps.pdfjs ?? (await loadPdfjs());
  const assets = assetUrls();

  let doc: Awaited<ReturnType<PdfjsLike['getDocument']>['promise']>;
  try {
    doc = await pdfjs.getDocument({
      // 传副本：pdfjs 会"接管"这份 buffer，复用原始引用会干扰调用方
      data: bytes.slice(),
      // Node 下没有 worker / fetch，关掉相关路径
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
      // 中文 PDF 的 CMap 与未内嵌的标准字体都靠这两个目录
      ...(assets.cMapUrl ? { cMapUrl: assets.cMapUrl, cMapPacked: true } : {}),
      ...(assets.standardFontDataUrl
        ? { standardFontDataUrl: assets.standardFontDataUrl }
        : {}),
    }).promise;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password/i.test(msg)) {
      throw new PdfImportError('这个 PDF 有打开密码，无法读取内容。');
    }
    if (/Invalid PDF/i.test(msg)) {
      throw new PdfImportError('这个文件不是有效的 PDF。');
    }
    throw new PdfImportError(`读取 PDF 失败：${msg}`);
  }

  const pages: PdfPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push({
      items: content.items as PdfTextItem[],
      width: viewport.width,
      height: viewport.height,
    });
  }

  const text = assemblePdf(pages);

  const verdict = looksLikeGarbage(text);
  if (verdict.garbage) {
    if (verdict.reason === 'empty') {
      throw new PdfImportError(
        '这个 PDF 里没有可提取的文字。它可能是一份扫描件（图片版）；' +
          '请用带 OCR 的工具先转成文字，或直接粘贴文字内容。',
      );
    }
    throw new PdfImportError(
      '这个 PDF 的文字无法正确解码（缺少字体映射表）。' +
        '请改用 Word/文本格式，或用「粘贴」把文字直接贴进来。',
    );
  }

  return text;
}
