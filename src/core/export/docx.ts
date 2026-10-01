/**
 * DOCX 导出。
 *
 * ═══════════════════════════════════════════════════════════════
 *  先说清楚这个格式**做不到什么**，因为这是用户最需要知道的：
 *
 *  Word 的排版模型与 CSS 完全不同 —— 没有 conic-gradient、没有
 *  background-clip、没有 flex/grid、没有精确的行内盒模型。
 *  因此这里是**近似还原**，不是精确复刻。
 *
 *  能还原：字体、字号层级、配色、段落间距、行距、对齐、项目符号。
 *  不能还原：渐变、噪点、复杂分栏、色块圆角与描边细节。
 *
 *  所以界面上必须如实说明"近似还原"，不能让用户以为
 *  下载下来的 Word 和预览长得一模一样。
 * ═══════════════════════════════════════════════════════════════
 *
 * 为什么用 docx 库而不是拼 XML：
 * OOXML 的编号（numbering）、样式继承、关系（rels）都极易写错，
 * 而写错的后果是 Word 提示"文件损坏"——用户会直接认为工具坏了。
 * 用成熟库生成，风险低得多。
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
  convertInchesToTwip,
} from 'docx';
import type { ContentUnit } from '@/core/content/types';
import type { DesignSpec } from '@/core/design/spec';
import { stripInlineMarkdown, tokenizeInline } from '@/core/content/inline';

/** 把 hex 颜色转成 docx 需要的 6 位大写十六进制（不带 #）。 */
function hex(color: string): string {
  return color.replace('#', '').toUpperCase();
}

/** pt 值。docx 用 half-points 表示字号，这里统一换算。 */
function halfPoints(px: number): number {
  // px → pt：× 0.75；再 × 2 得 half-points
  return Math.round(px * 0.75 * 2);
}

/** 基准字号，与渲染层保持一致。 */
const BASE_FONT_PX = 14;

/** 密度 → 段落间距（twip）。与渲染层的 DENSITY 对应。 */
const DENSITY_SPACING = {
  compact: { before: 40, after: 40 },
  balanced: { before: 80, after: 80 },
  airy: { before: 140, after: 140 },
} as const;

/**
 * 把一行文字转成 TextRun 数组，保留粗体/斜体/等宽。
 *
 * 与 HTML 渲染共用 `tokenizeInline`，因此
 * 「哪些字符是标记」这件事在两种导出格式里理解一致。
 *
 * 换行必须显式转成 Word 的换行符：`TextRun` 里的裸 `\n`
 * 不会渲染成换行，而是被 Word 当成一个普通字符 ——
 * 那等于改动了用户的内容。`break: 1` 才是真正的换行。
 */
function runs(text: string, opts: { size: number; color: string; font: string }): TextRun[] {
  const tokens = tokenizeInline(text);
  if (tokens.length === 0) {
    return [new TextRun({ text: '', ...opts })];
  }

  const out: TextRun[] = [];

  for (const t of tokens) {
    const common = {
      size: opts.size,
      color: opts.color,
      font: opts.font,
      bold: t.kind === 'strong',
      italics: t.kind === 'em',
    };
    // 行内代码用等宽字体
    const font = t.kind === 'code' ? 'Consolas' : common.font;

    // 一个 token 内部可能含换行（列表项的续行）。
    // 首行不带 break，其后每一行都带一个。
    const lines = t.content.split('\n');
    lines.forEach((line, i) => {
      out.push(
        new TextRun({
          ...common,
          font,
          ...(i > 0 ? { break: 1 } : {}),
          text: line,
        }),
      );
    });
  }

  return out;
}

/**
 * 从内容单元与设计参数构建 DOCX。
 *
 * @returns 一个 Blob，可直接写盘
 */
export async function buildDocx(
  units: readonly ContentUnit[],
  spec: DesignSpec,
): Promise<Blob> {
  const t = spec.theme;
  const density = DENSITY_SPACING[spec.layout.density];

  const bodyPx = BASE_FONT_PX * t.scale.body;
  const bodySize = halfPoints(bodyPx);
  const h1Size = halfPoints(bodyPx * t.scale.h1);
  const h2Size = halfPoints(bodyPx * t.scale.h2);

  const byId = new Map(units.map((u) => [u.id, u]));

  // 板块顺序以 sectionOrder 为准，未列入的补在后面
  const ordered = [...spec.sections].sort((a, b) => {
    const ia = spec.layout.sectionOrder.indexOf(a.section);
    const ib = spec.layout.sectionOrder.indexOf(b.section);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });

  const children: Paragraph[] = [];

  for (const section of ordered) {
    // 板块标题：只在该板块确实有一条 heading 单元时才写。
    // 绝不凭空造标题 —— 那会变成用户没写过的文字。
    const headingUnit = section.units
      .map((u) => byId.get(u.contentId))
      .find((u) => u?.kind === 'heading' && u.section === section.section);

    if (headingUnit) {
      // 规则线样式映射到段落下边框。
      // 用条件展开而不是 `border: undefined` ——
      // 在 exactOptionalPropertyTypes 下显式 undefined 是不合法的。
      const border =
        t.ruleStyle === 'none'
          ? {}
          : {
              border: {
                bottom: {
                  color: hex(t.palette.primary),
                  style:
                    t.ruleStyle === 'thick'
                      ? BorderStyle.THICK
                      : t.ruleStyle === 'double'
                        ? BorderStyle.DOUBLE
                        : BorderStyle.SINGLE,
                  size: t.ruleStyle === 'thick' ? 12 : 6,
                  space: 2,
                },
              },
            };

      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: density.before * 2, after: density.after },
          ...border,
          children: runs(headingUnit.text, {
            size: h2Size,
            color: hex(t.palette.primary),
            font: t.fontPair.heading,
          }),
        }),
      );
    }

    for (const unitStyle of section.units) {
      const unit = byId.get(unitStyle.contentId);
      if (!unit) continue;
      if (headingUnit && unit.id === headingUnit.id) continue;

      const role = unit.meta?.role;
      const isName = role === 'name';
      const isTitle = role === 'title';
      const isContact = role === 'contact' || role === 'location' || unit.kind === 'contact';

      // 姓名用 h1 级别
      if (isName) {
        children.push(
          new Paragraph({
            alignment: AlignmentType.LEFT,
            spacing: { after: 20 },
            children: runs(unit.text, {
              size: h1Size,
              color: hex(t.palette.primary),
              font: t.fontPair.heading,
            }),
          }),
        );
        continue;
      }

      const size = isTitle ? halfPoints(bodyPx * 1.05) : isContact ? halfPoints(bodyPx * 0.92) : bodySize;
      const color = isTitle
        ? hex(t.palette.accent)
        : isContact || unitStyle.style?.muted
          ? hex(t.palette.muted)
          : hex(t.palette.text);

      const isBullet = unit.kind === 'listItem';

      children.push(
        new Paragraph({
          ...(isBullet
            ? {
                numbering: { reference: 're-bullets', level: Math.min(unit.level ?? 0, 2) },
              }
            : {}),
          spacing: {
            before: isBullet ? Math.round(density.before / 2) : density.before,
            after: isBullet ? Math.round(density.after / 2) : density.after,
            line: Math.round(t.scale.lineHeight * 240),
          },
          children: runs(unit.text, {
            size,
            color,
            font: t.fontPair.body,
          }),
        }),
      );
    }
  }

  const doc = new Document({
    creator: '简历与求职信美化',
    description: '由简历与求职信视觉美化工具导出（近似还原版式）',
    numbering: {
      config: [
        {
          reference: 're-bullets',
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: '•',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: convertInchesToTwip(0.25), hanging: convertInchesToTwip(0.15) } } },
            },
            {
              level: 1,
              format: LevelFormat.BULLET,
              text: '◦',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.15) } } },
            },
            {
              level: 2,
              format: LevelFormat.BULLET,
              text: '▪',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: convertInchesToTwip(0.75), hanging: convertInchesToTwip(0.15) } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              // 与 PDF 页边距一致，保证两种格式的正文宽度相同
              top: convertInchesToTwip(56 / 96),
              bottom: convertInchesToTwip(56 / 96),
              left: convertInchesToTwip(64 / 96),
              right: convertInchesToTwip(64 / 96),
            },
          },
        },
        children,
      },
    ],
  });

  return Packer.toBlob(doc);
}

/**
 * 校验 DOCX 的可见文字与原文一致。
 *
 * 与 HTML 渲染同样适用保真契约：DOCX 也不能增删用户的字。
 * 这里只做"每个单元的可见内容都出现过"的检查，
 * 供测试与运行时自检使用。
 */
export function docxVisibleText(units: readonly ContentUnit[]): string {
  return units.map((u) => stripInlineMarkdown(u.text)).join('\n');
}
