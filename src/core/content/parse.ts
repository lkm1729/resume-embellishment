import { marked, type Tokens } from 'marked';
import type { ContentUnit, ParsedDocument, ParseMode, UnitKind } from './types';
import { annotateHeader } from './header';

/**
 * 内容解析器。
 *
 * 保真契约（贯穿全系统的定义）：
 *
 *   逐字保留 —— 单元 `text` 中的全部可见字符（含标点、空格、换行、行内 Markdown 语法）。
 *   允许规范化 —— 行首尾的空白、项目符号前缀（- * • 1. 等）、换行符风格（CRLF→LF）。
 *
 * 换句话说：**改变的是排版，绝不是文字**。项目符号和缩进本身就是排版，
 * 正是本工具要重做的东西，因此剥离它们不违反契约。
 *
 * `verifyFidelity()` 用可执行的方式校验这条契约。
 */

const DEFAULT_SECTION = '基本信息';

/** 常见简历板块名，用于纯文本模式下的板块识别。 */
const SECTION_KEYWORDS = new Set([
  // 中文
  '个人信息', '基本信息', '联系方式', '求职意向', '教育背景', '教育经历', '工作经历',
  '工作经验', '实习经历', '项目经历', '项目经验', '校园经历', '研究经历', '学术经历',
  '专业技能', '技能', '技能特长', '语言能力', '证书', '荣誉', '获奖经历', '获奖情况',
  '自我评价', '个人评价', '个人总结', '兴趣爱好', '发表论文', '专利', '作品集',
  '培训经历', '社会实践', '社团经历', '志愿服务', '其他',
  // 英文
  'PROFILE', 'SUMMARY', 'OBJECTIVE', 'CONTACT', 'EXPERIENCE', 'WORK EXPERIENCE',
  'EMPLOYMENT', 'EDUCATION', 'SKILLS', 'PROJECTS', 'PROJECT EXPERIENCE',
  'CERTIFICATIONS', 'CERTIFICATES', 'AWARDS', 'HONORS', 'PUBLICATIONS',
  'LANGUAGES', 'INTERESTS', 'VOLUNTEER', 'ACTIVITIES', 'ACHIEVEMENTS',
  'TRAINING', 'REFERENCES', 'PORTFOLIO', 'EXTRACURRICULAR',
]);

/** 匹配项目符号前缀，捕获缩进、符号与正文。 */
const BULLET_RE = /^([ \t]*)(?:([-*+•·‣▪◦∙]))[ \t]+(.*)$/;
/** 匹配有序列表前缀，如 "1. " / "2) " / "3、"。 */
const ORDERED_RE = /^([ \t]*)(\d{1,3})([.)、])[ \t]+(.*)$/;
/** 匹配形如 "2020.03 - 2023.06" 或 "2020年3月" 的日期行。 */
const DATE_RE = /^[\s]*(?:\d{4}[./年-]\d{1,2}|\d{4})\s*(?:[-–—~至]|to)\s*(?:\d{4}[./年-]\d{1,2}|至今|现在|present|now|迄今)/i;
/** 匹配联系方式行（邮箱 / 电话 / 链接）。 */
const CONTACT_RE = /(@[\w.-]+\.\w+|(?:\+?\d[\d\s-]{7,}\d)|https?:\/\/\S+|(?:github|linkedin)\.com\/\S+)/i;

/** 统计字符串的显示宽度（中日韩字符按 2 计）。 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += cp >= 0x1100 && (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xff00 && cp <= 0xff60)
    ) ? 2 : 1;
  }
  return w;
}

/** 判断一行是否是板块标题。 */
function asHeading(line: string): { text: string; level: number } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  // 1. 显式 Markdown 标题前缀
  const hashes = /^(#{1,6})\s+(.*)$/.exec(trimmed);
  if (hashes?.[1] && hashes[2] !== undefined) {
    return { text: hashes[2].trim(), level: hashes[1].length };
  }

  // 2. 中文方括号包裹：【工作经历】
  const bracketed = /^[【\[](.+?)[】\]]\s*[:：]?$/.exec(trimmed);
  if (bracketed?.[1]) return { text: bracketed[1].trim(), level: 2 };

  // 3. 板块关键词精确匹配（允许结尾冒号）
  const bare = trimmed.replace(/[:：]\s*$/, '').trim();
  if (SECTION_KEYWORDS.has(bare.toUpperCase()) || SECTION_KEYWORDS.has(bare)) {
    return { text: bare, level: 2 };
  }

  // 4. 短行 + 结尾冒号，视为标题
  if (/[:：]$/.test(trimmed) && displayWidth(trimmed) <= 20) {
    return { text: bare, level: 2 };
  }

  // 5. 短的全大写英文行，视为标题
  if (displayWidth(trimmed) <= 30 && /^[A-Z][A-Z\s&/'-]+$/.test(trimmed) && /[A-Z]{2}/.test(trimmed)) {
    return { text: trimmed, level: 2 };
  }

  return null;
}

/** 剥离项目符号，返回正文与缩进层级。 */
function stripBullet(line: string): { text: string; indent: number; ordered: boolean } | null {
  const b = BULLET_RE.exec(line);
  if (b && b[1] !== undefined && b[3] !== undefined) {
    return { text: b[3], indent: b[1].length, ordered: false };
  }
  const o = ORDERED_RE.exec(line);
  if (o && o[1] !== undefined && o[4] !== undefined) {
    return { text: o[4], indent: o[1].length, ordered: true };
  }
  return null;
}

/** 纯文本模式解析。 */
function parsePlain(source: string): Array<Omit<ContentUnit, 'id' | 'section'> & { section?: string }> {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: Array<Omit<ContentUnit, 'id' | 'section'> & { section?: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim().length === 0) continue;

    // 下划线式标题：本行有内容，下一行是 === 或 ---
    const next = lines[i + 1] ?? '';
    if (/^\s*(={3,}|-{3,})\s*$/.test(next) && line.trim().length > 0) {
      out.push({ kind: 'heading', text: line.trim(), level: 2 });
      i++;
      continue;
    }

    const heading = asHeading(line);
    if (heading) {
      out.push({ kind: 'heading', text: heading.text, level: heading.level });
      continue;
    }

    const bullet = stripBullet(line);
    if (bullet) {
      out.push({
        kind: 'listItem',
        text: bullet.text.trim(),
        ...(bullet.indent > 0 ? { level: Math.floor(bullet.indent / 2) } : {}),
      });
      continue;
    }

    const trimmed = line.trim();
    if (DATE_RE.test(trimmed)) {
      out.push({ kind: 'date', text: trimmed });
      continue;
    }
    if (CONTACT_RE.test(trimmed) && displayWidth(trimmed) <= 80) {
      out.push({ kind: 'contact', text: trimmed });
      continue;
    }

    out.push({ kind: 'paragraph', text: trimmed });
  }

  return out;
}

/**
 * 取一个列表项的正文。
 *
 * 正文从 `item.tokens` 里拼，而不是从 `item.raw` 里截：
 * 每个 token 的 `text` 已经剥掉了项目符号、保留了行内语法（`**粗体**`），
 * 松散写法下的续行也完整留在里面。
 *
 * 曾经的写法是取 `item.raw` 的**首个非空行** —— 那会丢掉续行：
 * `- 服务端研发\n  负责订单系统重构` 只剩「服务端研发」，
 * 直接违反保真契约（丢掉的是用户真写过的字）。
 *
 * 两个必须跳过的 token：
 *   - `list`：嵌套子列表由 `walkList` 递归收成独立单元（带 `level`）。
 *     若不跳过，它会同时出现在父项正文里，同一段文字**出现两次**。
 *   - `checkbox`：`- [ ] 待办` 的方框是标记而非正文，与项目符号同等对待。
 */
function listItemBody(item: Tokens.ListItem): string {
  const parts: string[] = [];
  for (const child of item.tokens) {
    if (child.type === 'list' || child.type === 'checkbox') continue;
    const text = (child as { text?: unknown }).text;
    if (typeof text !== 'string') continue;
    const normalized = text.replace(/\r\n?/g, '\n').trim();
    if (normalized.length > 0) parts.push(normalized);
  }
  if (parts.length > 0) return parts.join('\n');

  // 兜底：token 没给出正文（反常情况）时，从 raw 首行剥符号。
  const raw = item.raw.replace(/\r\n?/g, '\n');
  const firstLine = raw.split('\n').find((l) => l.trim().length > 0) ?? '';
  const stripped = stripBullet(firstLine);
  return (stripped?.text ?? firstLine).trim();
}

/** 从 marked 的 token 树中抽取块级单元，保留行内 Markdown 语法。 */
function parseMarkdown(source: string): Array<Omit<ContentUnit, 'id' | 'section'> & { section?: string }> {
  const out: Array<Omit<ContentUnit, 'id' | 'section'> & { section?: string }> = [];
  const tokens = marked.lexer(source.replace(/\r\n?/g, '\n'));

  const walkList = (token: Tokens.List, depth: number): void => {
    for (const item of token.items) {
      const text = listItemBody(item);
      if (text.length > 0) {
        out.push({ kind: 'listItem', text, ...(depth > 0 ? { level: depth } : {}) });
      }
      // 嵌套子列表
      for (const child of item.tokens) {
        if (child.type === 'list') walkList(child as Tokens.List, depth + 1);
      }
    }
  };

  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const h = token as Tokens.Heading;
        out.push({ kind: 'heading', text: h.text.trim(), level: h.depth });
        break;
      }
      case 'paragraph': {
        const p = token as Tokens.Paragraph;
        // 保留 raw（含行内语法），仅去掉尾部换行
        const text = p.raw.replace(/\n+$/, '').trim();
        if (text.length > 0) {
          const kind: UnitKind = DATE_RE.test(text) ? 'date'
            : CONTACT_RE.test(text) && displayWidth(text) <= 80 ? 'contact'
            : 'paragraph';
          out.push({ kind, text });
        }
        break;
      }
      case 'list':
        walkList(token as Tokens.List, 0);
        break;
      case 'blockquote': {
        const bq = token as Tokens.Blockquote;
        const text = bq.raw.replace(/^\s*>\s?/gm, '').trim();
        if (text.length > 0) out.push({ kind: 'paragraph', text });
        break;
      }
      case 'code': {
        const c = token as Tokens.Code;
        out.push({ kind: 'meta', text: c.text });
        break;
      }
      case 'table': {
        const t = token as Tokens.Table;
        // 表头 + 每行拼成一行，单元格以 " | " 分隔，保留可读性
        const header = t.header.map((c) => c.text.trim()).join(' | ');
        if (header.length > 0) out.push({ kind: 'meta', text: header });
        for (const row of t.rows) {
          const line = row.map((c) => c.text.trim()).join(' | ');
          if (line.length > 0) out.push({ kind: 'meta', text: line });
        }
        break;
      }
      // space / hr / html 等不产生内容单元
      default:
        break;
    }
  }

  return out;
}

/** 为单元分配 ID 与板块归属。 */
function assign(partials: Array<Omit<ContentUnit, 'id' | 'section'> & { section?: string }>): ContentUnit[] {
  let currentSection = DEFAULT_SECTION;
  const units: ContentUnit[] = [];

  for (let i = 0; i < partials.length; i++) {
    const p = partials[i];
    if (!p) continue;
    if (p.kind === 'heading') currentSection = p.text;

    const id = `u${String(i + 1).padStart(4, '0')}`;
    const unit: ContentUnit = {
      id,
      kind: p.kind,
      section: p.section ?? currentSection,
      text: p.text,
      ...(p.level !== undefined ? { level: p.level } : {}),
      ...(p.meta !== undefined ? { meta: p.meta } : {}),
    };
    units.push(unit);
  }

  return units;
}

/** 规范化序列化，保证同一输入必得同一字符串。 */
function canonicalize(units: readonly ContentUnit[]): string {
  return JSON.stringify(
    units.map((u) => [u.id, u.kind, u.section, u.text, u.level ?? null, u.meta ?? null]),
  );
}

/** 计算内容哈希（SHA-256 十六进制）。 */
export async function hashUnits(units: readonly ContentUnit[]): Promise<string> {
  const data = new TextEncoder().encode(canonicalize(units));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 解析用户输入为冻结的内容单元。
 *
 * 同一输入必定产生完全相同的 `units` 与 `contentHash`，
 * 这是历史回滚与导出可复现的基础。
 *
 * 流程：语法解析 → 头部标注（只在 meta 里加 role，不改 text）→ 冻结哈希。
 */
export async function parseDocument(source: string, mode: ParseMode): Promise<ParsedDocument> {
  const partials = mode === 'markdown' ? parseMarkdown(source) : parsePlain(source);
  const units = annotateHeader(assign(partials));

  const sections: string[] = [];
  for (const u of units) {
    if (!sections.includes(u.section)) sections.push(u.section);
  }

  return {
    units,
    contentHash: await hashUnits(units),
    sections,
    mode,
  };
}
