/**
 * 渲染器。
 *
 * ═══════════════════════════════════════════════════════════════
 *  本模块是 `(ContentUnit[], DesignSpec) → HTML` 的**纯函数**。
 *
 *  这个性质支撑了三件事，且保证三者视觉完全一致：
 *    · 历史回滚 = 重放 DesignSpec，不需要存成品
 *    · 导出     = 同一份 HTML 换一种序列化
 *    · 预览     = 同一份 HTML 加个缩放容器
 *
 *  因此本模块**绝不读取** `spec.rationale`（那是给 UI 看的文案），
 *  也绝不产生任何用户没写过的可见文字。
 * ═══════════════════════════════════════════════════════════════
 *
 * 输出的是 HTML 字符串而不是 React 组件，理由有二：
 *   1. PDF 导出要靠 WebView 打印**真实的 DOM**，
 *      用 `dangerouslySetInnerHTML` 注入同一份 HTML 即可，无需两套渲染；
 *   2. 纯字符串便于单测直接做文本级断言（保真校验就是文本级的）。
 */

import type { ContentUnit } from '@/core/content/types';
import type { DesignSpec, SectionSpec, UnitStyle } from '@/core/design/spec';
import { renderInlineMarkdown } from './inline';

/** A4 宽度（@96dpi）。导出时视口会被锁到这个宽度。 */
export const A4_WIDTH_PX = 794;

/**
 * A4 高度（@96dpi）。
 *
 * 与宽度放在一起，是因为这两个数在三个地方被用到：
 *   · 预览板（估算页数、画分页虚线）
 *   · 分页导出的尺寸守卫（算合成图高度是否会触到 canvas 上限）
 *   · 导出时的打印设置（见 src-tauri/src/export.rs 的页边距注释）
 * 之前高度只在预览板里定义了一次，导出侧要用就得再写一遍 ——
 * 两处常量迟早会不一致，所以收到这里统一。
 */
export const A4_HEIGHT_PX = 1123;

/** 基准字号（px）。spec 里的 scale 是相对它的倍数。 */
const BASE_FONT_PX = 14;

/**
 * 密度 → 间距的映射。
 *
 * 注意：**密度只管间距，不管行高**。
 * 行高由 `theme.scale.lineHeight` 单独控制。
 * 两个旋钮各管一件事，避免"改了 density 却发现行高没动"这种困惑：
 *   · scale.lineHeight —— 段内节奏（一行文字的疏密）
 *   · density          —— 块间节奏（板块与条目之间的距离）
 */
const DENSITY = {
  compact: { sectionGap: 12, itemGap: 3 },
  balanced: { sectionGap: 18, itemGap: 5 },
  airy: { sectionGap: 26, itemGap: 8 },
} as const;

/** HTML 转义。用户内容一律经此进入 DOM，杜绝标签注入。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 把字体族名拼成可以安全放进 `<style>` 的字体栈。
 *
 * 原本 `fontPair` 只可能是 `FONT_WHITELIST` 里的 19 个名字，直接拼毫无风险；
 * 但 V0.1.2 起用户可以指定**本机任意字体族**（见 `spec.ts` 的 `withFontOverride`），
 * 而族名是字体表里的自由字符串 —— 里面出现 `"` 或 `</style>` 就能突破一条声明
 * 甚至整个样式块。CSP 是 `style-src 'self' 'unsafe-inline'`，注入进去的 CSS
 * 会生效（`script-src 'self'` 挡住了脚本，所以这是加固，不是堵漏）。
 *
 * 剥掉的是 CSS 里不可能出现在族名中的结构性字符，普通名字原样通过。
 * 名字被剥空时**整段丢掉**，退回默认栈 —— `font-family: "", "Microsoft YaHei"…`
 * 会因为第一个名字非法而让**整条**声明失效，连回退链一起丢，
 * 那比只丢一个名字糟得多。
 *
 * `FontBlock` 里那两处内联 `fontFamily` 不必走这里：React 是把它当 CSSOM
 * 属性赋值的，注不出额外声明。
 */
function fontStack(name: string): string {
  const safe = name.replace(/["\\;<>{}()]/g, '').trim();
  return safe.length > 0
    ? `"${safe}", "Microsoft YaHei", "Noto Sans SC", sans-serif`
    : '"Microsoft YaHei", "Noto Sans SC", sans-serif';
}

/** 板块名 → 稳定的 CSS 类名后缀，避免依赖中文做选择器。 */
function sectionSlug(index: number): string {
  return `sec-${index}`;
}

export interface RenderOptions {
  /** 是否内联 `<style>`。导出与预览需要；纯片段测试时可关掉。 */
  includeStyle?: boolean;
  /** 额外注入的类名（预览容器用）。 */
  extraClass?: string;
}

/**
 * 渲染整个文档。
 *
 * 单元顺序严格按 `spec.sections[].units[]` 给出的顺序 ——
 * 这正是「允许重排版块与分组」这一需求的落点：
 * 文字不变，但顺序、分组、强调可调。
 */
export function renderDocument(
  units: readonly ContentUnit[],
  spec: DesignSpec,
  options: RenderOptions = {},
): string {
  const { includeStyle = true, extraClass = '' } = options;

  const byId = new Map(units.map((u) => [u.id, u]));
  const density = DENSITY[spec.layout.density];

  // ── 板块顺序：以 sectionOrder 为准，未列入的板块按原文顺序补在后面 ──
  const ordered: SectionSpec[] = [];

  for (const name of spec.layout.sectionOrder) {
    const found = spec.sections.find((s) => s.section === name);
    if (found && !ordered.includes(found)) ordered.push(found);
  }
  // 未在 sectionOrder 里声明的板块按原顺序补在后面。
  // 校验层会拦这种情况，但渲染层保持宽容：
  // 宁可多渲染一个板块，也绝不能让用户的文字凭空消失。
  for (const s of spec.sections) {
    if (!ordered.includes(s)) ordered.push(s);
  }

  const body = ordered
    .map((section, i) => renderSection(section, i, byId))
    .filter((s) => s.length > 0)
    .join('\n');

  const style = includeStyle ? renderStyle(spec, density) : '';

  return [
    `<div class="doc ${escapeHtml(extraClass).trim()}" data-template="${spec.layout.template}">`,
    style,
    body,
    '</div>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 渲染一个板块。 */
function renderSection(
  section: SectionSpec,
  index: number,
  byId: Map<string, ContentUnit>,
): string {
  const rendered: string[] = [];

  for (const unitStyle of section.units) {
    const unit = byId.get(unitStyle.contentId);
    // 引用了不存在的单元：跳过而不是输出占位文字。
    // 任何占位文字都会变成"用户没写过的内容"，是保真契约的红线。
    if (!unit) continue;
    rendered.push(renderUnit(unit, unitStyle));
  }

  if (rendered.length === 0) return '';

  const cls = [
    'section',
    sectionSlug(index),
    `emphasis-${section.style.emphasis}`,
    section.style.columns === 2 ? 'cols-2' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // 板块标题用板块名本身 —— 但仅当它确实是原文里的一条 heading 单元时。
  // 否则会凭空造出一个用户没写过的标题。
  const headingUnit = section.units
    .map((u) => byId.get(u.contentId))
    .find((u) => u?.kind === 'heading' && u.section === section.section);

  const heading = headingUnit
    ? `<h2 class="section-title">${renderInlineMarkdown(headingUnit.text)}</h2>`
    : '';

  // 标题单元已被单独渲染，正文里要跳过它，避免重复
  const bodyItems = headingUnit
    ? section.units.filter((u) => u.contentId !== headingUnit.id)
    : section.units;

  const bodyHtml = bodyItems
    .map((unitStyle) => {
      const unit = byId.get(unitStyle.contentId);
      if (!unit) return '';
      return renderUnit(unit, unitStyle);
    })
    .filter(Boolean)
    .join('\n');

  return [
    `<section class="${cls}">`,
    heading,
    heading ? '<div class="section-rule" aria-hidden="true"></div>' : '',
    `<div class="section-body">`,
    bodyHtml,
    '</div>',
    '</section>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 渲染单个内容单元。 */
function renderUnit(unit: ContentUnit, style: UnitStyle): string {
  const s = style.style ?? {};
  const role = unit.meta?.role;

  // 元素类型：优先用模型指定的 `as`，否则按 kind 推断
  const tag = s.as ?? defaultTag(unit);

  const cls = [
    'unit',
    `kind-${unit.kind}`,
    role ? `role-${role}` : '',
    s.weight ? `w-${s.weight}` : '',
    s.muted ? 'muted' : '',
    unit.level !== undefined && unit.kind === 'listItem' ? `indent-${unit.level}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  // 行内 Markdown 渲染：**粗体** 变成 <strong>，但文字本身一个字符不改。
  // 这是唯一允许"解释"用户文字的地方，且解释结果不增加可见字符。
  const inner = renderInlineMarkdown(unit.text);

  return `<${tag} class="${cls}">${inner}</${tag}>`;
}

/** 按单元类型推断合适的标签。 */
function defaultTag(unit: ContentUnit): string {
  switch (unit.kind) {
    case 'heading':
      return unit.level === 1 ? 'h1' : unit.level === 3 ? 'h3' : 'h2';
    case 'listItem':
      return 'li';
    case 'date':
    case 'contact':
      return 'p';
    default:
      return 'p';
  }
}

/**
 * 生成样式表。
 *
 * 所有尺寸都从 spec 推导，不引入任何 spec 之外的视觉常量 ——
 * 否则"模型控制版式"就成了空话。
 */
function renderStyle(spec: DesignSpec, density: (typeof DENSITY)[keyof typeof DENSITY]): string {
  const t = spec.theme;
  const p = t.palette;
  const sc = t.scale;

  const bodyPx = (BASE_FONT_PX * sc.body).toFixed(2);
  const h1Px = (BASE_FONT_PX * sc.body * sc.h1).toFixed(2);
  const h2Px = (BASE_FONT_PX * sc.body * sc.h2).toFixed(2);

  const headingFont = fontStack(t.fontPair.heading);
  const bodyFont = fontStack(t.fontPair.body);

  const rule = ruleStyle(t.ruleStyle, p.accent, p.primary);
  const emphasis = emphasisStyles(p);

  return `<style>
.doc {
  width: ${A4_WIDTH_PX}px;
  box-sizing: border-box;
  padding: 56px 64px;
  background: ${p.bg};
  color: ${p.text};
  font-family: ${bodyFont};
  font-size: ${bodyPx}px;
  line-height: ${sc.lineHeight};
  /* 中文断行：允许在任意字之间断开，避免长串溢出 */
  word-break: break-word;
  overflow-wrap: anywhere;
}
.doc * { box-sizing: border-box; }
.doc h1, .doc h2, .doc h3, .doc h4 {
  font-family: ${headingFont};
  margin: 0;
  font-weight: 600;
  color: ${p.primary};
}
.doc h1 { font-size: ${h1Px}px; line-height: 1.2; }
.doc h2 { font-size: ${h2Px}px; line-height: 1.25; }
.doc h3 { font-size: ${bodyPx}px; }
.doc h4 { font-size: ${bodyPx}px; font-weight: 500; }
.doc p, .doc li { margin: 0; }
.doc strong { font-weight: 700; }
.doc em { font-style: italic; }
.doc code {
  font-family: Consolas, "Courier New", ui-monospace, monospace;
  font-size: 0.94em;
}

/* ── 板块 ── */
.section { margin-bottom: ${density.sectionGap}px; }
.section:last-child { margin-bottom: 0; }
.section-title { margin-bottom: 4px !important; }
.section-rule { ${rule} margin-bottom: ${Math.round(density.sectionGap / 2)}px; }
.section-body { display: flex; flex-direction: column; gap: ${density.itemGap}px; }
.section.cols-2 .section-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  column-gap: 24px;
}

/* ── 单元 ── */
/* 列表项渲染成裸 <li>（不在 <ul>/<ol> 里），但 UA 样式表对 li 照样画 disc marker，
   而下面的 ::before 又画了一个 —— 叠起来就是预览里的「••正文」。
   规则：只要「是列表项」或「被渲染成 li」，就只有一个点 —— 我们自己这个。
   list-style:none 压掉 UA marker；圆点改挂在 li.unit 与 kind-listItem 两条路径上，
   这样无论走 defaultTag 还是模型指定的 as:'li'，长得都一样。 */
.unit.kind-listItem,
li.unit {
  list-style: none;
  position: relative;
  padding-left: 1.1em;
}
.unit.kind-listItem::before,
li.unit::before {
  content: '';
  position: absolute;
  left: 0.25em;
  top: 0.62em;
  width: 0.28em;
  height: 0.28em;
  border-radius: 50%;
  background: ${p.muted};
}
.unit.indent-1 { margin-left: 1.1em; }
.unit.indent-2 { margin-left: 2.2em; }
.unit.muted { color: ${p.muted}; }
.unit.w-bold { font-weight: 700; }
.unit.w-medium { font-weight: 500; }

/* 头部角色：姓名放大、职位用强调色、联系方式用小字灰色 */
.unit.role-name {
  font-family: ${headingFont};
  font-size: ${(Number(bodyPx) * 1.9).toFixed(2)}px;
  line-height: 1.15;
  font-weight: 600;
  color: ${p.primary};
  margin-bottom: 2px;
}
.unit.role-title {
  font-size: ${(Number(bodyPx) * 1.05).toFixed(2)}px;
  color: ${p.accent};
  font-weight: 500;
}
.unit.role-contact, .unit.role-location {
  font-size: ${(Number(bodyPx) * 0.92).toFixed(2)}px;
  color: ${p.muted};
}
.unit.kind-date { color: ${p.muted}; font-size: ${(Number(bodyPx) * 0.94).toFixed(2)}px; }
.unit.kind-contact { color: ${p.muted}; font-size: ${(Number(bodyPx) * 0.94).toFixed(2)}px; }

${emphasis}

/* ── 打印 ──
   导出 PDF 时用：去掉外边距，让分页由 A4 高度决定。 */
@media print {
  .doc { padding: 48px 56px; }
  .section { break-inside: avoid; }
  .unit { break-inside: avoid; }
}
</style>`;
}

/** 规则线样式。 */
function ruleStyle(kind: DesignSpec['theme']['ruleStyle'], accent: string, primary: string): string {
  switch (kind) {
    case 'none':
      return 'display: none;';
    case 'thin':
      return `border-top: 1px solid ${primary}33; height: 0;`;
    case 'thick':
      return `border-top: 2.5px solid ${primary}; height: 0;`;
    case 'double':
      return `border-top: 3px double ${primary}66; height: 0;`;
    case 'accent-bar':
      return `border-top: 3px solid ${accent}; height: 0; width: 56px;`;
    default:
      return 'display: none;';
  }
}

/** 板块强调样式。 */
function emphasisStyles(p: DesignSpec['theme']['palette']): string {
  return `
.section.emphasis-banded > .section-title {
  background: ${p.primary};
  color: ${p.bg};
  padding: 4px 10px;
  margin-left: -10px;
  margin-right: -10px;
}
.section.emphasis-banded > .section-rule { display: none; }
.section.emphasis-boxed {
  border: 1px solid ${p.primary}33;
  border-radius: 4px;
  padding: 12px 14px;
}
`;
}

/**
 * 从渲染结果中提取可见文本。
 *
 * 与 `verifyFidelity` 配合使用：把渲染出的 HTML 转成纯文本后，
 * 逐单元比对用户原文是否完整保留。
 *
 * `<br>` 必须先还原成换行再剥标签：它代表的是一个**真实的换行**，
 * 如果直接连标签一起删掉，"第一行/第二行"会粘成"第一行第二行"，
 * 保真比对就会把一个没有发生的改动报成差异。
 */
export function extractVisibleText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
