/**
 * 结构化输出的回退链。
 *
 * ═══════════════════════════════════════════════════════════════
 *  为什么必须有回退链，而不是直接用 json_schema：
 *
 *  用户自备的是第三方 / 自建端点（OneAPI、NewAPI、Ollama、各类中转），
 *  它们对 `response_format` 的支持参差不齐 ——
 *  有的支持 json_schema 严格模式，有的只认 json_object，
 *  有的两者都声称支持但实际忽略，还有的会在收到未知字段时直接 400。
 *
 *  不能假设可用，只能逐层降级。
 * ═══════════════════════════════════════════════════════════════
 *
 * 层级（越靠前越可靠，也越快）：
 *   1. json_schema   —— 原生严格模式，端点自己保证结构
 *   2. json_object   —— 只保证是 JSON，schema 靠 prompt 内嵌
 *   3. text          —— 纯文本，从回复里提取首个平衡 JSON 块
 *   4. repair        —— 校验失败时把具体错误回灌，重试一次
 *
 * 本模块只负责「纯函数」部分：决定下一层用什么策略、
 * 从任意文本里抠出 JSON。真正的 HTTP 调用在 Rust 侧。
 */

import type { Capabilities } from '@/core/llm/types';

/** 结构化输出的策略层级。 */
export type OutputStrategy = 'json_schema' | 'json_object' | 'text';

/** 一次尝试失败的结构化原因。用它做分类，而不是去 sniff 错误文本。 */
export type FailureReason =
  /** 调用层失败：网络、鉴权、限流、模型不存在。换层也救不了。 */
  | 'call'
  /** 回复里根本没有可解析的 JSON。 */
  | 'unparseable'
  /** 有 JSON，但结构或语义不合法。 */
  | 'invalid';

/** 一个策略的执行结果。 */
export interface StrategyAttempt {
  readonly strategy: OutputStrategy;
  readonly ok: boolean;
  /** 失败原因（中文，可直接展示）。 */
  readonly failure?: string;
  /** 失败的结构化分类。成功时为 undefined。 */
  readonly reason?: FailureReason;
}

/**
 * 根据探测到的能力，排出可用的策略顺序。
 *
 * 原则：**只跳过端点明确不支持的层级**，不做乐观假设。
 * 若能力未知（探测从未成功过），给全三层 ——
 * 让实际调用去证伪，比我们猜错后让用户看到失败要好。
 */
export function planStrategies(caps: Capabilities | undefined): OutputStrategy[] {
  const all: OutputStrategy[] = ['json_schema', 'json_object', 'text'];
  if (!caps) return all;

  const planned: OutputStrategy[] = [];
  if (caps.jsonSchema) planned.push('json_schema');
  if (caps.jsonObject) planned.push('json_object');
  // text 层不需要端点支持任何特性 —— 永远可用，是最后的兜底
  planned.push('text');

  // 能力标志全为 false 时上面的判断会只剩 text，这是正确的降级
  return planned.length > 0 ? planned : all;
}

/**
 * 从模型回复里提取一个 JSON 对象。
 *
 * 为什么需要它：
 * 即使要求"只输出 JSON"，模型仍常输出这些形态：
 *   - 包在 ```json 代码块里
 *   - 前后带一句解释（"好的，这是设计结果："）
 *   - 末尾多一个逗号
 *   - 被截断（max_tokens 用尽）
 *
 * 做法：**括号配平扫描**，而不是正则。
 * 正则处理不了嵌套，也处理不了字符串里的花括号。
 *
 * @returns 解析出的对象；失败时返回 null
 */
export function extractJsonObject(text: string): unknown | null {
  const candidates = candidateSlices(text);

  for (const slice of candidates) {
    const parsed = tryParse(slice);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** 按可能性从高到低，生成待尝试的 JSON 片段。 */
function candidateSlices(text: string): string[] {
  const out: string[] = [];
  const trimmed = text.trim();

  // 1. 整段就是一个 JSON
  out.push(trimmed);

  // 2. 代码块里的内容（```json ... ``` 或 ``` ... ```）
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m[1]) out.push(m[1].trim());
  }

  // 3. 括号配平扫描出来的第一个完整对象
  const balanced = firstBalancedObject(text);
  if (balanced) out.push(balanced);

  return out;
}

/**
 * 括号配平扫描：找到第一个完整且配平的 `{...}`。
 *
 * 必须正确处理字符串字面量 —— 否则用户简历里的
 * `"他说：{"` 这种内容会让计数错乱（中文简历里罕见，但 URL 里常见）。
 */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  // 没配平 —— 很可能是被 max_tokens 截断了
  return null;
}

function tryParse(s: string): unknown | null {
  if (s.length === 0) return null;
  try {
    const v: unknown = JSON.parse(s);
    // 只接受对象：DesignSpec 是对象，数组说明模型理解错了任务
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * 常见的、可自动修复的 JSON 错误。
 *
 * 刻意做得保守：**只修不改变语义的问题**。
 * 比如尾逗号、中文引号、注释。
 * 不做任何需要"猜"的修复 —— 猜错会静默改变用户的版式。
 */
export function repairCommonJsonIssues(text: string): string {
  let s = text;

  // 中文全角引号 → 半角（模型偶尔会把 JSON 的引号写成全角）
  s = s.replace(/[\u201c\u201d]/g, '"');

  // 去掉尾逗号：`},]` 或 `},}` 或 `},  }`
  s = s.replace(/,(\s*[}\]])/g, '$1');

  // 去掉 // 行注释（模型有时会"贴心地"加注释）
  // 连同行尾换行一起删掉，避免留下空行
  s = s.replace(/^[ \t]*\/\/.*(?:\r?\n|$)/gm, '');

  return s.trim();
}

/** 判断一个解析结果是否"看起来像" DesignSpec（用于区分模型跑偏 vs 结构小错）。 */
export function looksLikeDesignSpec(v: unknown): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return 'layout' in o && 'theme' in o && 'sections' in o;
}

/**
 * 生成「修复轮」的提示词。
 *
 * 与其让模型从头再来，不如把**具体错在哪**告诉它 —— 命中率显著更高。
 * 但要注意：错误信息里可能含用户内容片段，回灌是安全的（模型已经见过内容清单），
 * 只是不要在这句话里引入新的自由文本要求。
 */
export function buildRepairInstruction(issues: readonly string[]): string {
  return [
    '你上一次的输出无法通过校验，错误如下：',
    ...issues.map((i) => `- ${i}`),
    '',
    '请修正后重新输出**完整的** JSON 对象。',
    '特别注意：',
    '1. 只能引用下方清单里真实存在的内容单元 ID；',
    '2. 每一个内容单元都必须被引用且只被引用一次；',
    '3. 只能使用清单里列出的板块名；',
    '4. 字体必须来自白名单；颜色必须是 6 位十六进制。',
  ].join('\n');
}

/**
 * 生成「降低野心」的提示词。
 *
 * 用于模型反复输出了非法 spec 的情况 ——
 * 常见于模型想做出花哨版式，却记不住 ID 格式或板块名。
 * 这时引导它做一个保守但合法的 spec，比继续失败有价值得多：
 * 用户拿到一个朴素但正确的成品，远好过拿到一个错误提示。
 */
export function buildFallbackInstruction(): string {
  return [
    '你的输出持续无法通过结构校验。请改用最保守的方案重新输出：',
    '',
    '- layout.template 用 "single-column"（单栏）',
    '- layout.sectionOrder 就按清单里板块出现的原顺序',
    '- layout.density 用 "balanced"',
    '- theme.fontPair 用 "Calibri" / "Calibri"',
    '- theme.palette：primary 用 "#1F2937"、accent 用 "#C9A227"、',
    '  text 用 "#111827"、muted 用 "#6B7280"、bg 用 "#FFFFFF"',
    '- theme.scale 用 h1: 1.6、h2: 1.25、body: 1、lineHeight: 1.5',
    '- theme.ruleStyle 用 "thin"，cornerRadius 用 0',
    '- sections 里每个板块的 units 按清单顺序逐个列出其 contentId',
    '',
    '不要做任何创意发挥，目标是产出一个**结构完全合法**的 JSON。',
  ].join('\n');
}
