/**
 * 行内标记的解析。
 *
 * ═══════════════════════════════════════════════════════════════
 *  本模块定义「哪些字符是**排版标记**，哪些是**内容**」。
 *
 *  这条界线是保真契约的一部分：
 *  用户在 Markdown 模式写 `**前端**`，那两个星号是**排版意图**
 *  （"这里要加粗"），不是内容 —— 就像行首的 `- ` 是排版而不是内容。
 *  本工具要做的事正是重做排版，所以这些标记会被消费掉。
 *
 *  但被消费的只能是标记本身：`**前端**` → `前端`，
 *  一个可见字符都不能多、不能少。
 *
 *  为什么用一个**共享的 tokenizer** 而不是两个正则：
 *  「渲染成 HTML」与「剥离标记后比对」必须对语法有一致的理解。
 *  若各写一套，某天给渲染器加了新语法而忘了同步剥离器，
 *  保真校验就会开始误报或漏报 —— 而且是静默的。
 *  共用一次解析，从结构上杜绝这种漂移。
 * ═══════════════════════════════════════════════════════════════
 */

/** 行内片段。 */
export interface InlineToken {
  readonly kind: 'text' | 'strong' | 'em' | 'code' | 'link';
  /** **可见内容**（不含标记字符）。拼接全部 token 的 content 即得纯文本。 */
  readonly content: string;
  /** 仅 link 有：链接地址。刻意不用于渲染成 <a>（见 render 层说明）。 */
  readonly href?: string;
}

/**
 * 解析行内标记。
 *
 * 采用单遍扫描而非一串 replace：
 * 顺序敏感的替换规则极易互相破坏（例如 `**x**` 被斜体规则先拆开），
 * 而单遍扫描里每个位置的判断都是局部的、可推理的。
 */
export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let buf = '';

  /** 把累积的普通文字收尾成一个 text token。 */
  const flush = (): void => {
    if (buf.length > 0) {
      tokens.push({ kind: 'text', content: buf });
      buf = '';
    }
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    // ── 行内代码：内容原样保留，不再解析内部标记 ──
    const code = /^`([^`]+)`/.exec(rest);
    if (code?.[1] !== undefined) {
      flush();
      tokens.push({ kind: 'code', content: code[1] });
      i += code[0].length;
      continue;
    }

    // ── 链接：只取文字，地址单独存 ──
    const link = /^\[([^\]]+)\]\(([^)]*)\)/.exec(rest);
    if (link?.[1] !== undefined) {
      flush();
      tokens.push({ kind: 'link', content: link[1], href: link[2] ?? '' });
      i += link[0].length;
      continue;
    }

    // ── 粗体：`**x**` / `__x__`，内容里不允许再出现同类标记 ──
    const strong = /^(?:\*\*([^*]+)\*\*|__([^_]+)__)/.exec(rest);
    if (strong) {
      const inner = strong[1] ?? strong[2] ?? '';
      flush();
      tokens.push({ kind: 'strong', content: inner });
      i += strong[0].length;
      continue;
    }

    // ── 斜体：`*x*` / `_x_` ──
    // 刻意要求「标记紧贴文字」且「结束标记后是边界」，
    // 否则 `2022 * 2023` 与 `snake_case_name` 会被误判成斜体。
    const em = /^(?:\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_)(?=[\s).,;:!?]|$)/.exec(rest);
    if (em) {
      const inner = em[1] ?? em[2] ?? '';
      // 起始侧也必须是边界（行首或前面是空白/左括号），
      // 由「当前 buf 为空且不在行首」来判断
      const prevChar = i > 0 ? text[i - 1] : undefined;
      const leftOk =
        prevChar === undefined || /\s/.test(prevChar) || prevChar === '(' || prevChar === '（';
      if (leftOk) {
        flush();
        tokens.push({ kind: 'em', content: inner });
        i += em[0].length;
        continue;
      }
    }

    // ── 都不是：按普通字符累积 ──
    buf += text[i];
    i++;
  }

  flush();
  return tokens;
}

/**
 * 去掉行内标记，得到纯文本。
 *
 * 这是保真比对的**规范形式**：`verifyFidelity` 用它把
 * 「原文」与「渲染结果」拉到同一个基准上比较。
 */
export function stripInlineMarkdown(text: string): string {
  return tokenizeInline(text)
    .map((t) => t.content)
    .join('');
}

/**
 * 判断一段文字是否含行内标记。
 *
 * 用于快速跳过无标记的常见情况，避免无谓解析。
 */
export function hasInlineMarkdown(text: string): boolean {
  return /[*_`[]/.test(text);
}
