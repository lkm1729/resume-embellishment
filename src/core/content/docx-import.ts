/**
 * DOCX 正文抽取。
 *
 * ═══════════════════════════════════════════════════════════════
 *  这段代码的**唯一目标**是把 Word 里的可见文字还原出来，
 *  交给方块 1 做排版。它不解析样式、不保留表格结构、
 *  不还原页眉页脚 —— 那些都只是"版式"，而版式本来就是要被重做的。
 *
 *  因此这里的取舍是：**宁可漏掉修饰，不可丢掉文字**。
 * ═══════════════════════════════════════════════════════════════
 *
 * 为什么是"抽取"而不是"转换"：
 * 用户拿到一份旧简历 .docx，要的是把里面的文字喂进工具重新排版。
 * 所以输出只需要是一段可编辑的纯文本，行与行的关系大致对就够了。
 *
 * 段落划分：
 *   · 每个 <w:p> 一行 —— 换段落就是换行
 *   · <w:br> 与 <w:cr> 也换行（软换行，Word 里按 Shift+Enter）
 *   · 制表符 <w:tab> 转成空格（简历里常用于对齐联系方式）
 */

import { readZipEntry, ZipError } from './zip';

/** 正文所在的条目路径。Word 固定用这个名字。 */
const DOCUMENT_XML = 'word/document.xml';

/**
 * 这些元素的内容不属于"用户当前的正文"，整体跳过：
 *   · `w:instrText` 域代码（页码、目录等公式）
 *   · `w:delText`  修订中被删除的文字
 *   · `w:del`      同上（包裹 delText 的外层）
 *   · `w:proofErr` 拼写检查标记（无文字，但保持一致性）
 */
const IGNORED = new Set(['w:instrText', 'w:delText', 'w:del', 'w:proofErr']);

/** 抽取失败时抛出，消息可直接展示给用户。 */
export class DocxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxError';
  }
}

/**
 * 把 XML 实体还原成字符。
 *
 * 只处理 XML 规范里预定义的那五个 + 数字字符引用。
 * 不做"猜测式"解码 —— DOCX 的 XML 是严格格式化的，
 * 多余的宽容只会让畸形输入悄悄通过。
 */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(cp) ? safeFromCodePoint(cp, whole) : whole;
    }
    if (body.startsWith('#')) {
      const cp = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? safeFromCodePoint(cp, whole) : whole;
    }
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return whole;
    }
  });
}

/**
 * 码点转字符，并挡掉非法码点。
 *
 * `String.fromCodePoint` 对超出 Unicode 范围的值会抛异常。
 * 一个畸形字符不该让整份文档导入失败，所以退化成保留原样。
 * 同时挡掉代理区（U+D800–U+DFFF）—— 单独出现时是非法字符。
 */
function safeFromCodePoint(cp: number, fallback: string): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return fallback;
  }
  try {
    return String.fromCodePoint(cp);
  } catch {
    return fallback;
  }
}

/**
 * 从 document.xml 抽取段落文本。
 *
 * 用**状态机扫描**而不是正则替换：
 * 正则处理不了"标签属性里恰好含 >"或"嵌套标签顺序错乱"这类情况，
 * 而这里必须保证不把标记文本当成正文吐给用户。
 *
 * @returns 每个元素是一个段落（可能为空串，表示空行）
 */
export function extractParagraphs(xml: string): string[] {
  const paragraphs: string[] = [];
  /** 当前段落正在累积的文字片段。 */
  let buf = '';
  /** 是否处于 `<w:t>` 内部 —— 只有这里面的文字才是正文。 */
  let inText = false;
  /**
   * 是否处于 `<w:r>`（run）内部。
   *
   * 需要单独记录，因为 `<w:br>` / `<w:tab>` / `<w:noBreakHyphen>`
   * 是 **run 的直接子元素，而不是 `<w:t>` 的子元素**：
   *
   *   <w:r><w:t>a</w:t><w:br/><w:t>b</w:t></w:r>
   *
   * 只看 `inText` 会把它们全部漏掉 —— 加粗、换行、制表符都消失，
   * 而且**没有任何报错**。
   */
  let inRun = false;
  /**
   * 要忽略的区域栈。
   *
   * 用栈而不是计数器：不同名字的元素可能互相嵌套
   * （`<w:del>` 里还有 `<w:delText>`），用单一计数器会在
   * 遇到未成对出现的标签时把后续正文一起吃掉。
   */
  const skipStack: string[] = [];

  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      // 文件末尾的裸文字（正常情况下不存在）
      if (inText && skipStack.length === 0) buf += decodeXmlEntities(xml.slice(i));
      break;
    }

    // 收集标签之前的文字
    if (lt > i && inText && skipStack.length === 0) {
      buf += decodeXmlEntities(xml.slice(i, lt));
    }

    const gt = findTagEnd(xml, lt);
    if (gt < 0) break; // 未闭合的标签，忽略剩余部分

    const parsed = parseTag(xml.slice(lt + 1, gt));
    i = gt + 1;
    if (!parsed) continue;
    const { name, closing, selfClosing, attrs } = parsed;

    // ── 要忽略的区域 ──
    // `<w:instrText>` 是域代码（如页码公式），`<w:del>` 是修订中已删除的内容。
    // 两者都不属于用户当前的正文。
    if (IGNORED.has(name)) {
      if (closing) {
        const at = skipStack.lastIndexOf(name);
        if (at >= 0) skipStack.length = at;
      } else if (!selfClosing) {
        skipStack.push(name);
        inText = false; // 进入忽略区后，之前的 `<w:t>` 状态作废
        inRun = false;
      }
      continue;
    }

    // ── 段落边界 ──
    // `<w:p/>`（自闭合）也会出现在文档里，它代表一个空段落。
    if (name === 'w:p') {
      if (closing || selfClosing) {
        paragraphs.push(buf);
        buf = '';
        inText = false;
        inRun = false;
      }
      // 段落开始不需要特别处理：`buf` 已经是空的，
      // 文字会在 `<w:t>` 分支里被标记为正文。
      continue;
    }

    if (skipStack.length > 0) continue;

    // ── run 边界 ──
    // 一个 run 结束时**不插入任何字符**：Word 把同一个词拆成多个 run
    // 是常态（粗体切换、拼写检查标记都会造成拆分），
    // 在接缝处补空格就等于改了用户的字。
    if (name === 'w:r') {
      if (closing || selfClosing) {
        inRun = false;
        inText = false;
      } else {
        inRun = true;
      }
      continue;
    }

    // ── 文字容器 ──
    if (name === 'w:t') {
      inText = !closing && !selfClosing;
      continue;
    }

    // ── run 内的结构元素 ──
    // 这些既不是文字也不是段落边界，但**是文档的可见内容**，
    // 必须处理，否则换行会静默丢失、文字会粘连成一团。
    if (inRun && !closing && (name === 'w:br' || name === 'w:cr')) {
      // `<w:br w:type="page">` 是分页符，不是换行；不产生空行。
      const type = attrs.get('w:type');
      if (type !== 'page' && type !== 'column') buf += '\n';
      continue;
    }

    if (inRun && !closing && name === 'w:tab') {
      buf += ' ';
      continue;
    }

    // 不换行连字符是个真实可见的字符（如 "2020‑2023"），
    // 丢了就等于改了用户的字。
    if (inRun && !closing && name === 'w:noBreakHyphen') {
      buf += '\u2011';
      continue;
    }

    // 软连字符是**不可见**的排版提示，不该进入纯文本，
    // 否则用户会看到莫名其妙的多余字符。
    if (inRun && !closing && name === 'w:softHyphen') {
      continue;
    }
  }

  // 文档没有闭合的 </w:p> 时，别把最后一段丢掉
  if (buf.length > 0) paragraphs.push(buf);

  return paragraphs;
}

/**
 * 找到标签的结束位置 `>`。
 *
 * 不能直接用 `indexOf('>')` —— 属性值里可能有 `>`，例如
 * `<w:t xml:space="preserve">a>b</w:t>` 这种（虽然罕见但合法）。
 * 引号内的 `>` 要跳过。
 */
function findTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

interface ParsedTag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: Map<string, string>;
}

/** 解析一个标签的内部内容（不含尖括号）。 */
function parseTag(tag: string): ParsedTag | null {
  const closing = tag.startsWith('/');
  const body = closing ? tag.slice(1) : tag;
  const selfClosing = body.endsWith('/');
  const inner = selfClosing ? body.slice(0, -1) : body;

  const nameEnd = inner.search(/[\s/]/);
  const name = nameEnd < 0 ? inner : inner.slice(0, nameEnd);
  if (name.length === 0) return null;

  const attrs = new Map<string, string>();
  if (nameEnd >= 0) {
    const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    attrRe.lastIndex = nameEnd;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(inner)) !== null) {
      const key = m[1];
      if (key === undefined) continue;
      attrs.set(key, m[3] ?? m[4] ?? '');
    }
  }

  return { name, closing, selfClosing, attrs };
}

/**
 * 从 DOCX 字节流抽取纯文本。
 *
 * @throws {DocxError} 文件不是 DOCX、缺正文、或格式不支持
 */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  let xmlBytes: Uint8Array | null;
  try {
    xmlBytes = await readZipEntry(bytes, DOCUMENT_XML);
  } catch (e) {
    if (e instanceof ZipError) throw new DocxError(e.message);
    throw new DocxError(
      `读取 DOCX 失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!xmlBytes) {
    throw new DocxError(
      '这个文件里没有找到正文（word/document.xml）。' +
        '如果它是 .doc 旧格式，请先用 Word 另存为 .docx。',
    );
  }

  const xml = new TextDecoder('utf-8').decode(xmlBytes);
  const paragraphs = extractParagraphs(xml);

  return normalizeExtractedText(paragraphs);
}

/**
 * 规范化抽取结果。
 *
 * 只做**安全的**整理：
 *   · 行尾空白去掉（Word 里常留一堆空格）
 *   · 连续空行压成一个（Word 的段落间距会被抽成空段落）
 *   · 首尾去空
 *
 * 刻意**不**合并"看起来该在一行"的内容 ——
 * 那属于对用户文字的判断，越界了。
 */
export function normalizeExtractedText(paragraphs: readonly string[]): string {
  const out: string[] = [];
  let blank = false;

  for (const raw of paragraphs) {
    const line = raw.replace(/[ \t]+$/g, '');
    if (line.trim().length === 0) {
      if (!blank && out.length > 0) out.push('');
      blank = true;
      continue;
    }
    blank = false;
    out.push(line);
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
