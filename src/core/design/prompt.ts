/**
 * Prompt 组装。
 *
 * ═══════════════════════════════════════════════════════════════
 *  本模块的核心职责：把模型**必须知道**的与**绝不能知道**的分开。
 *
 *  必须知道：内容单元的 ID 清单、板块结构、风格取向、岗位与补充资料。
 *  绝不能知道：能诱导它输出正文的机会。
 *
 *  具体做法 —— 提示词里明确写出"你没有输出正文的能力"，
 *  并让 schema 承担硬约束。语言约束会被模型偶尔忽略，
 *  但 schema 不会：DesignSpec 里根本没有能装正文的字段。
 * ═══════════════════════════════════════════════════════════════
 */

import type { ContentUnit } from '@/core/content/types';
import type { WorkbenchInput } from '@/core/content/reference';
import type { ImageAttachment } from '@/core/llm/types';
import { ROLE_LABELS } from '@/core/content/reference';
import { buildStyleBrief } from './presets';
import type { DesignSpec } from './spec';
import { DESIGN_SPEC_JSON_SCHEMA, FONT_WHITELIST } from './spec';

/** 内容清单的一行：`u0003 [listItem] 工作经历｜负责核心交易链路…`。 */
function describeUnit(u: ContentUnit): string {
  const role = u.meta?.role ? ` {头部角色:${u.meta.role}}` : '';
  const level = u.level !== undefined ? ` {层级:${u.level}}` : '';
  return `${u.id} [${u.kind}] ${u.section}${role}${level}｜${u.text}`;
}

/**
 * 组装系统提示词。
 *
 * 长度控制：内容清单必须完整（漏了就会漏渲染），
 * 但超长简历可能塞爆上下文。调用方需先过 `truncateUnits`。
 */
export function buildSystemPrompt(): string {
  return [
    '# 角色',
    '你是一位资深的排版与视觉设计专家，专门为简历和求职信做**视觉呈现设计**。',
    '你把一份朴素但内容扎实的文档，变成层次清晰、气质恰当、值得细看的版面。',
    '',
    '# 你的能力边界（最重要的一条）',
    '你**只能输出样式与结构决策**，不能输出、改写、增删任何一个字。',
    '原因不是权限限制，而是你的输出 schema 里**根本不存在**可以承载正文的字段。',
    '你唯一能提及用户内容的方式，是通过内容单元的 ID 来引用它。',
    '',
    '因此：',
    '- 不要复述用户的内容；',
    '- 不要"顺手优化"措辞；',
    '- 不要补充你认为用户漏写的信息；',
    '- 如果某个单元的文字你觉得不够好，那是用户的选择，你的任务是把它排得好看。',
    '',
    '# 输出格式',
    '只输出一个 JSON 对象，不要包裹在代码块里，不要有任何解释性前后缀。',
    'JSON 必须严格符合下面的 schema。',
    '',
    '```json',
    JSON.stringify(DESIGN_SPEC_JSON_SCHEMA, null, 2),
    '```',
    '',
    '# 硬性约束',
    `1. fontPair 的两个字体必须来自白名单：${FONT_WHITELIST.join(', ')}`,
    '2. 颜色一律用 6 位十六进制（如 #1F2937），不要用颜色名或 rgb()。',
    '3. `sections[].units[].contentId` 只能取自下方给出的 ID 清单，不得编造。',
    '4. `layout.sectionOrder` 与 `sections[].section` 只能使用下方列出的板块名。',
    '5. **每一个内容单元都必须被引用且只引用一次。** 漏引用会让用户的文字凭空消失，',
    '   这是最不可接受的失败；重复引用会让同一段文字印两遍。',
    '6. 不得新增任何表示内容的字段。除 `rationale` 外，所有字段都是样式参数。',
    '',
    '# rationale 字段',
    '`rationale` 用于向用户解释你的设计思路（120 字以内为宜）。',
    '它只会显示在界面上，不会进入排版结果，所以在这里写自然语言是安全的。',
  ].join('\n');
}

/**
 * 组装用户消息：内容清单 + 上下文 + 风格要求。
 */
export function buildUserPrompt(
  units: readonly ContentUnit[],
  sections: readonly string[],
  input: WorkbenchInput,
  docType: 'resume' | 'cover-letter',
): string {
  const parts: string[] = [];

  parts.push(
    `# 待设计的文档：${docType === 'resume' ? '简历' : '求职信'}`,
    '',
    `共 ${units.length} 个内容单元，${sections.length} 个板块。`,
    '',
    '## 内容单元清单',
    '格式：`ID [类型] 板块 {标注}｜原文`',
    '',
    '```',
    ...units.map(describeUnit),
    '```',
    '',
    '## 板块清单',
    '`layout.sectionOrder` 与 `sections[].section` 只能使用这些名字：',
    '',
    ...sections.map((s) => `- ${s}`),
  );

  // 目标岗位：帮助模型判断"该突出什么"。
  if (input.targetRole.trim()) {
    parts.push(
      '',
      '## 目标岗位资料',
      '（仅供你判断设计取向，**不得**把这段文字放进任何输出字段）',
      '',
      '```',
      input.targetRole.trim().slice(0, 2000),
      '```',
    );
  }

  // 额外补充
  if (input.extraNotes.trim()) {
    parts.push(
      '',
      '## 额外补充资料',
      '（仅供你判断设计取向，**不得**把这段文字放进任何输出字段）',
      '',
      '```',
      input.extraNotes.trim().slice(0, 2000),
      '```',
    );
  }

  // 参考资料：按归属区分重要性
  //
  // ⚠ 图片不能按 `text` 是否为空筛 —— 它的 `text` 只是名字，
  // 正文在 `dataBase64` 里。只保留图片的条件单独写。
  const refs = input.references.filter(
    (r) => r.source.kind === 'image' || r.text.trim().length > 0,
  );
  if (refs.length > 0) {
    const lines = refs.map((r) => {
      const label = ROLE_LABELS[r.role];

      // 图片走单独一条：它没有正文，`text` 只是名字。
      // 把它当文字塞进代码块，模型会以为那串名字就是资料的全部内容。
      if (r.source.kind === 'image') {
        const size = r.source.storedSize ?? r.source.size;
        return `### [${label}] ${r.source.fileName}\n`
          + `（这是一张**随本次请求一起发送的图片**，约 ${Math.round(size / 1024)} KB。`
          + '直接看图判断它体现的版式、配色与信息层级，不要试图把图里的文字抄进成品。）';
      }

      const origin =
        r.source.kind === 'file'
          ? r.source.fileName
          : r.source.kind === 'url'
            ? r.source.url
            : '粘贴内容';
      const body = r.text.trim().slice(0, 1500);
      return `### [${label}] ${origin}\n${
        r.role === 'primary'
          ? '这是一份待排版的正文素材。**注意：它没有被解析成内容单元，**'
            + '因此你只能参考它的风格信息，不能引用其内容。'
          : '仅作为设计取向的参考，绝不进入成品。'
      }\n\`\`\`\n${body}\n\`\`\``;
    });

    parts.push(
      '',
      '## 参考资料',
      '标记为「设计参考」「目标岗位」「补充资料」的内容**只是给你看的**，',
      '成品种绝不能出现它们的任何文字。',
      '',
      ...lines,
    );
  }

  parts.push('', '# 风格要求', '', buildStyleBrief(input.presetId, input.customStyle));
  parts.push(
    '',
    '# 请输出',
    '严格符合 schema 的 JSON 对象，引用全部内容单元，每个一次。',
  );

  return parts.join('\n');
}

/**
 * 超长文档的截断。
 *
 * 优先策略：**不截断内容单元**（截了就会漏渲染）。
 * 应当先压缩的是参考资料 —— 它们只是参考，删掉不损失保真。
 * 因此本函数只负责判断"是否超限"，实际裁剪由调用方对 references 做。
 */
export function estimatePromptChars(
  units: readonly ContentUnit[],
  input: WorkbenchInput,
): number {
  const unitChars = units.reduce((n, u) => n + u.text.length + 30, 0);
  const ctxChars = input.targetRole.length + input.extraNotes.length;
  const refChars = input.references.reduce((n, r) => n + r.text.length, 0);
  return unitChars + ctxChars + refChars;
}

/** 上下文预算（字符数）。保守取值，中文大致 1 字符 ≈ 1 token 量级。 */
export const PROMPT_CHAR_BUDGET = 60000;

/**
 * 一次「在现有版式上继续调整」的上下文。
 *
 * 之所以要把**上一版 spec 原样带上**，而不是只发一句新要求：
 * 「标题再大一点」里的"再"是相对于**当前这一版**说的。
 * 不给模型看当前值，它只能猜一个"大"出来 ——
 * 那不是在调整，是重新设计，用户前一次的满意之处会被一并抹掉。
 */
export interface RefineContext {
  readonly spec: DesignSpec;
  /** 用户这次的调整要求（原话）。 */
  readonly instruction: string;
}

/**
 * 组装"继续调整"那一段提示词。
 *
 * 第一条约束（只改被要求的部分）是本段存在的全部理由：
 * 用户说"把标题变大"，期待的是**其他一切都不动**。
 * 模型天然倾向于顺手"优化"整份设计，所以必须明说。
 */
export function buildRefineSection(ctx: RefineContext): string {
  return [
    '# 继续调整（这不是重新设计）',
    '',
    '用户在上一版的基础上提出了新的要求。',
    '',
    '## 当前版式（上一版，用户已经看过并接受了其余部分）',
    '',
    '```json',
    JSON.stringify(ctx.spec, null, 2),
    '```',
    '',
    '## 用户这次的调整要求',
    '',
    '```',
    ctx.instruction.trim().slice(0, 2000),
    '```',
    '',
    '## 你必须遵守',
    '',
    '1. **只改动用户要求涉及的部分。** 其余字段逐一保持原值 ——',
    '   包括让你觉得"可以更好"的地方。用户没有要求，就不要动。',
    '2. 输出的是**完整**的 spec（不是差异补丁），所有内容单元仍然必须各被引用一次。',
    '3. 如果用户的要求与现有结构冲突（如要求两栏，但文档只有一个板块），',
    '   照最接近其意图的方式改，并在 `rationale` 里说明你做了什么取舍。',
  ].join('\n');
}

/**
 * 挑出要随请求下发的图片。
 *
 * 与文字资料不同，这里**不看 `role`**：图片全部是给模型看的设计参考，
 * 没有任何一条会「进入成品」—— 用户选的是「送进模型当设计参考」。
 * 归属选择对图片的意义只在于影响 `buildUserPrompt` 里的标注。
 *
 * 空载荷的图片会被跳过：拼出 `data:image/png;base64,` 只会让端点回 400，
 * 而那个错误指不到真正的原因。
 */
export function collectImages(input: WorkbenchInput): ImageAttachment[] {
  const out: ImageAttachment[] = [];
  for (const r of input.references) {
    if (r.source.kind !== 'image') continue;
    if (r.source.dataBase64.trim().length === 0) continue;
    out.push({
      mime: r.source.mime,
      dataBase64: r.source.dataBase64,
      name: r.source.fileName,
    });
  }
  return out;
}

/** 参考资料裁剪结果。 */
export interface TrimResult {
  readonly references: WorkbenchInput['references'];
  readonly dropped: number;
}

/**
 * 在超预算时按"最不重要优先"裁剪参考资料。
 *
 * 顺序（先删的先走）：设计参考 → 补充资料 → 目标岗位 → 我的正文。
 * 「我的正文」永远最后才动，且只截断不删除 —— 它是保真的底线。
 */
export function trimReferences(
  input: WorkbenchInput,
  budget = PROMPT_CHAR_BUDGET,
): TrimResult {
  if (estimatePromptChars([], input) <= budget) {
    return { references: input.references, dropped: 0 };
  }

  const priority: Record<string, number> = {
    reference: 0,
    extra: 1,
    target: 2,
    primary: 3,
  };

  // 低优先级先被丢弃
  const sorted = [...input.references].sort(
    (a, b) => (priority[a.role] ?? 0) - (priority[b.role] ?? 0),
  );

  const kept = new Set(input.references.map((r) => r.id));
  let total = estimatePromptChars([], input);
  let dropped = 0;

  for (const r of sorted) {
    if (total <= budget) break;
    if (r.role === 'primary') continue; // 正文不动
    kept.delete(r.id);
    total -= r.text.length;
    dropped++;
  }

  return {
    references: input.references.filter((r) => kept.has(r.id)),
    dropped,
  };
}
