/**
 * 行内标记 → HTML。
 *
 * ═══════════════════════════════════════════════════════════════
 *  这是整个系统里**唯一**把用户文字变成标签的地方，
 *  因此正确性判据非常特殊：
 *
 *    去掉标签后的可见文字，必须与 `stripInlineMarkdown(原文)` 逐字相同。
 *
 *  注意基准是**剥离标记后**的原文，而不是原文本身 ——
 *  因为 `**` 是排版标记，它被消费掉是设计意图（详见 content/inline.ts）。
 *
 *  解析用 `content/inline.ts` 的同一个 tokenizer，
 *  所以「渲染」与「比对」对语法的理解不可能不一致。
 * ═══════════════════════════════════════════════════════════════
 */

import { tokenizeInline } from '@/core/content/inline';

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
 * 渲染行内标记为 HTML。
 *
 * 关于链接刻意不生成 `<a>`：
 * 这个工具的定位是**排版**，简历在纸质件上链接不可点；
 * 而生成可点击元素会引入一个 DesignSpec 无法控制的交互行为。
 * 链接文字原样保留，因此不违反保真。
 *
 * 换行（`\n`）渲染成 `<br>`：Markdown 列表项可以有续行，
 * 解析后的 `unit.text` 因此可能是多行的。直接交给 HTML 会被
 * 折叠成一个空格 —— 用户写的是两行，看到一行，那是内容被改动。
 * `<br>` 不增加任何可见字符，保真判据（见文件头）依然成立。
 */
export function renderInlineMarkdown(text: string): string {
  return tokenizeInline(text)
    .map((t) => {
      // 内容一律转义后再包标签
      const safe = escapeHtml(t.content);
      switch (t.kind) {
        case 'strong':
          return `<strong>${safe}</strong>`;
        case 'em':
          return `<em>${safe}</em>`;
        case 'code':
          return `<code>${safe}</code>`;
        case 'link':
          return safe;
        default:
          return safe;
      }
    })
    .join('')
    .replace(/\n/g, '<br>');
}
