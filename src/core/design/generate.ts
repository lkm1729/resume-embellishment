/**
 * 生成编排。
 *
 * 把「prompt 组装 → 调用模型 → 解析 → 校验 → 修复」串成一条链，
 * 并如实记录每一层走到了哪里。
 *
 * ═══════════════════════════════════════════════════════════════
 *  一个刻意的设计：**失败时不静默降级**。
 *
 *  如果模型始终无法产出合法 spec，我们宁可返回明确的错误，
 *  也不"尽力而为"地套一个默认版式 —— 后者会让用户以为
 *  这是模型为他设计的，而实际上他得到的是模板。
 *  只有明确告知「这是保守兜底方案」，降级才是诚实的。
 * ═══════════════════════════════════════════════════════════════
 */

import type { ContentUnit } from '@/core/content/types';
import type { WorkbenchInput } from '@/core/content/reference';
import type { Capabilities, ImageAttachment } from '@/core/llm/types';
import type { DesignSpec } from './spec';
import { validateSpec, type SpecValidationIssue } from './validate';
import {
  buildRefineSection,
  buildSystemPrompt,
  buildUserPrompt,
  collectImages,
  trimReferences,
} from './prompt';
import {
  buildFallbackInstruction,
  buildRepairInstruction,
  extractJsonObject,
  planStrategies,
  repairCommonJsonIssues,
  type OutputStrategy,
  type StrategyAttempt,
} from './fallback';

/** 一次生成的完整结果。 */
export interface GenerationOutcome {
  readonly ok: boolean;
  readonly spec?: DesignSpec;
  /** 实际走通的策略层级。用于在 UI 上如实展示端点能力。 */
  readonly strategy?: OutputStrategy;
  /** 每一层的尝试记录。 */
  readonly attempts: readonly StrategyAttempt[];
  /** 失败时的可读说明（中文）。 */
  readonly error?: string;
  /** 是否用了保守兜底方案（UI 必须显著提示）。 */
  readonly usedConservativeFallback: boolean;
  /** 被裁掉的参考资料条数（如实告知用户）。 */
  readonly droppedReferences: number;
  /**
   * 因模型设置（`multimodal: false`）而没有下发的参考图张数。
   *
   * 必须报出来：用户贴了图却看到模型完全没提，会以为是自己没贴成功。
   * 0 表示没有图片被拦下。
   */
  readonly skippedImages: number;
}

/**
 * 调用模型的最小接口。
 *
 * 抽成接口是为了让整个编排逻辑**可被单测覆盖**，
 * 不必真的发 HTTP 请求。真实实现在 `llmClient`。
 *
 * 刻意**不包含** jsonSchema 之类的传输细节：
 * 「怎么向端点索要结构化输出」是适配器的职责，
 * 编排层只关心「要什么策略」与「拿回什么文本」。
 */
export interface ChatRequest {
  system: string;
  user: string;
  /** 期望的输出策略。实现方据此决定用哪种 response_format。 */
  strategy: OutputStrategy;
  /**
   * 随请求下发的图片（设计参考）。
   *
   * 刻意放在请求层而不是 prompt 字符串里：图片走的是**独立的多模态分段**，
   * 不是文本。把它拼进提示词只会得到一串 base64 字符，
   * 既烧掉几百万 token，模型也看不见任何东西。
   *
   * 为空时实现方必须让请求体与从前完全一致 —— 不支持视觉的模型
   * 不该因为一个空数组收到陌生结构。
   */
  images?: readonly ImageAttachment[] | undefined;
}

export interface ChatClient {
  chat(req: ChatRequest): Promise<string>;
}

/** 生成参数。 */
export interface GenerationParams {
  readonly units: readonly ContentUnit[];
  readonly sections: readonly string[];
  readonly input: WorkbenchInput;
  readonly docType: 'resume' | 'cover-letter';
  readonly capabilities?: Capabilities | undefined;
  /** 最多尝试几次修复轮。默认 1（即「修复一次」）。 */
  readonly maxRepairs?: number;
  /**
   * 上一版 spec + 本次调整要求。
   *
   * 有它时走的是「继续调整」而不是「从零设计」——
   * 两者的提示词完全不同（见 `buildRefineSection`）。
   */
  readonly refine?: { readonly spec: DesignSpec; readonly instruction: string } | undefined;
  /**
   * 是否允许把参考图下发给模型。默认允许。
   *
   * 由「模型设置」里的多模态开关决定（见 `core/llm/model-settings.ts`）。
   * 门控必须在这里做、而不是在传输层拦：`buildUserPrompt` 拿到的
   * 输入里还带着这些图，而传输层把它们悄悄丢掉的话，
   * 用户和模型都不知道发生过什么。
   */
  readonly allowImages?: boolean | undefined;
}

/**
 * 执行一次生成。
 *
 * 流程：
 *   1. 按能力排出策略顺序
 *   2. 逐层尝试：调用 → 提取 JSON → zod 校验 → 语义校验
 *   3. 任一层的校验失败都可触发一次修复轮（把错误回灌）
 *   4. 全部失败 → 用保守兜底方案再试一次，并标记 usedConservativeFallback
 */
export async function generateDesignSpec(
  client: ChatClient,
  params: GenerationParams,
): Promise<GenerationOutcome> {
  const attempts: StrategyAttempt[] = [];
  const strategies = planStrategies(params.capabilities);
  const maxRepairs = params.maxRepairs ?? 1;

  // 参考资料可能超预算，先按优先级裁剪
  const trimmed = trimReferences(params.input);
  const effectiveInput: WorkbenchInput = { ...params.input, references: trimmed.references };

  // ⚠ 图片从**未裁剪**的输入里取。
  //
  // `trimReferences` 是按字符数丢低优先级的，而图片在字符口径上几乎不占地方
  // （它的 `text` 只是名字），却可能因为归属是「设计参考」而在超预算时被判定为
  // 最可丢的那一类。用户亲手贴进来的图被悄悄丢掉，比多占几 MB 请求体糟得多。
  const images = collectImages(params.input);

  // 用户声明这个模型不吃图片时，在这里就拦下 —— 一个字节都不发出去。
  // `blockedImages` 会一路带到 UI，让"贴了图但模型没提"这件事有个解释。
  const blockedImages = params.allowImages === false ? images.length : 0;
  const sentImages = blockedImages > 0 ? [] : images;

  const system = buildSystemPrompt();
  const baseUser = [
    buildUserPrompt(params.units, params.sections, effectiveInput, params.docType),
    // 「继续调整」是接在正常提示词后面的一段，而不是替换它 ——
    // 内容单元清单、板块清单、硬性约束在调整时同样必须成立。
    ...(params.refine ? ['', buildRefineSection(params.refine)] : []),
  ].join('\n');

  /** 一次「调用 + 校验」，返回 spec 或错误清单。 */
  async function attempt(
    strategy: OutputStrategy,
    userPrompt: string,
  ): Promise<
    | { kind: 'ok'; spec: DesignSpec }
    | { kind: 'invalid'; issues: readonly SpecValidationIssue[]; raw: string }
    | { kind: 'unparseable'; raw: string }
    | { kind: 'threw'; message: string }
  > {
    let raw: string;
    try {
      raw = await client.chat({
        system,
        user: userPrompt,
        strategy,
        ...(sentImages.length > 0 ? { images: sentImages } : {}),
      });
    } catch (e) {
      return { kind: 'threw', message: e instanceof Error ? e.message : String(e) };
    }

    const parsed =
      extractJsonObject(raw) ?? extractJsonObject(repairCommonJsonIssues(raw));

    if (parsed === null) return { kind: 'unparseable', raw };

    const result = validateSpec(parsed, params.units, params.sections);
    if (result.ok && result.spec) return { kind: 'ok', spec: result.spec };

    return { kind: 'invalid', issues: result.issues, raw };
  }

  // ── 逐层降级 ──
  for (const strategy of strategies) {
    let userPrompt = baseUser;
    let result = await attempt(strategy, userPrompt);

    // ── 修复轮 ──
    for (let repair = 0; repair < maxRepairs; repair++) {
      if (result.kind === 'ok') break;

      const issues =
        result.kind === 'invalid'
          ? result.issues.map((i) => `[${i.kind}] ${i.message}`)
          : result.kind === 'unparseable'
            ? ['返回内容中找不到合法的 JSON 对象']
            : [`调用失败：${result.message}`];

      // 调用失败（网络/鉴权）时重试同层没有意义，直接换下一层
      if (result.kind === 'threw') break;

      userPrompt = `${baseUser}\n\n${buildRepairInstruction(issues)}`;
      result = await attempt(strategy, userPrompt);
    }

    if (result.kind === 'ok') {
      attempts.push({ strategy, ok: true });
      return {
        ok: true,
        spec: result.spec,
        strategy,
        attempts,
        usedConservativeFallback: false,
        droppedReferences: trimmed.dropped,
        skippedImages: blockedImages,
      };
    }

    attempts.push({
      strategy,
      ok: false,
      reason:
        result.kind === 'invalid'
          ? 'invalid'
          : result.kind === 'unparseable'
            ? 'unparseable'
            : 'call',
      failure:
        result.kind === 'invalid'
          ? result.issues.map((i) => `${i.kind}: ${i.message}`).join('；')
          : result.kind === 'unparseable'
            ? '无法从回复中提取 JSON'
            : result.message,
    });
  }

  // ── 保守兜底 ──
  // 走到这里说明所有策略 + 修复轮都失败了。
  // 再用最低野心的指令试一次；成功也要如实标记，让 UI 明确提示用户这是兜底结果。
  const conservative = await attempt('text', `${baseUser}\n\n${buildFallbackInstruction()}`);
  if (conservative.kind === 'ok') {
    attempts.push({ strategy: 'text', ok: true });
    return {
      ok: true,
      spec: conservative.spec,
      strategy: 'text',
      attempts,
      usedConservativeFallback: true,
      droppedReferences: trimmed.dropped,
      skippedImages: blockedImages,
    };
  }

  return {
    ok: false,
    attempts,
    error: describeFailure(attempts, params.units.length, sentImages.length),
    usedConservativeFallback: false,
    droppedReferences: trimmed.dropped,
    skippedImages: blockedImages,
  };
}

/**
 * 把失败链整理成一句人能看懂的话。
 *
 * 关键：告诉用户**下一步该做什么**，而不是只复述错误。
 * 自备端点的失败原因五花八门，用户往往不知道该改哪里。
 *
 * 分类依据是结构化的 `reason` 字段，不是去 sniff 错误文本 ——
 * 后者会因为文案改动而悄悄失效。
 *
 * ⚠ 各层的失败原因必须**去重**。
 * 回退链是「json_schema → json_object → text」三层，而「供应商没配 API Key」
 * 这种错误在**每一层**都会原样复现。直接 map 出来就会看到同一句话印三遍，
 * 看起来像三个独立故障，反而让人以为是配置之外还有别的问题。
 * 同一句话只留一次，末尾补一句"试过哪几层"即可。
 */
function describeFailure(
  attempts: readonly StrategyAttempt[],
  unitCount: number,
  imageCount = 0,
): string {
  const lines: string[] = ['模型未能产出合法的设计方案。'];

  const callFails = attempts.filter((a) => a.reason === 'call');
  const unparseable = attempts.filter((a) => a.reason === 'unparseable');
  const invalid = attempts.filter((a) => a.reason === 'invalid');

  // 调用层错误最优先报 —— 它是用户最能直接处理的一类
  if (callFails.length > 0) {
    const messages = uniqueMessages(callFails);
    lines.push('', '调用失败：', ...messages.map((m) => `- ${m}`));

    // 只有确实重试过多层时才提这件事，否则是噪音。
    if (callFails.length > 1 && messages.length < callFails.length) {
      lines.push(
        '',
        `（上述错误在 ${callFails.length} 次尝试中重复出现 —— 换用别的输出格式也救不了，` +
          '因为问题出在调用本身，不在结构化输出。）',
      );
    }

    lines.push(
      '',
      '请检查：API Key 是否有效、Base URL 是否正确（需包含 /v1 这类版本段）、该模型名是否可用。',
    );

    // 带图失败时，视觉能力是最值得怀疑的一条 ——
    // 而端点的报错往往只含糊地说"请求不合法"，用户根本想不到是图的问题。
    if (imageCount > 0) {
      lines.push(
        '',
        `⚠ 这次请求带了 ${imageCount} 张图片。若上面的报错提到请求格式/内容不合法，`,
        '很可能是**这个模型不支持图片输入**。可以改用支持视觉的模型，',
        '或先把图片移除再生成一次 —— 只保留文字资料同样能生成。',
      );
    }
  }

  if (unparseable.length > 0) {
    lines.push(
      '',
      '模型返回的内容里没有可解析的 JSON，说明它没有遵循"只输出 JSON"的要求。',
      '建议：换用指令遵循能力更强的模型；或确认该中转端点是否改写了返回内容。',
    );
  }

  if (invalid.length > 0) {
    lines.push(
      '',
      '模型返回了 JSON，但结构或引用不合法。常见原因：',
      `- 模型能力较弱，难以稳定遵循 schema 约束；`,
      `- 内容单元较多（当前 ${unitCount} 个），模型记不全 ID。`,
      '',
      '建议：换用能力更强的模型；或把简历拆短一些再生成。',
    );
  }

  // 兜底：连分类信息都没有时，至少把原始记录摊开
  if (callFails.length === 0 && unparseable.length === 0 && invalid.length === 0) {
    lines.push(
      '',
      '各层尝试记录：',
      ...attempts.map((a) => `- ${a.strategy}：${a.failure ?? '未成功'}`),
    );
  }

  return lines.join('\n');
}

/**
 * 取出各次尝试的失败文本，按内容去重（保持首次出现的顺序）。
 *
 * 比较前先把连续空白折叠掉：同一个原因经过不同层时可能带上细微的格式差异
 * （多一个换行、多一个空格），那些差异对用户没有意义，不该让去重失效。
 */
function uniqueMessages(attempts: readonly StrategyAttempt[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const a of attempts) {
    const raw = (a.failure ?? '').trim();
    if (raw.length === 0) continue;
    const key = raw.replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }

  return out.length > 0 ? out : ['（没有可用的错误详情。）'];
}

/**
 * 纯本地的兜底 spec。
 *
 * 用途：当**完全没有可用模型**时（比如用户没配供应商就想看效果），
 * 也能让渲染预览跑起来。这**不是**生成的替代品 ——
 * 调用方必须在界面上明确标注「未使用模型，这是默认版式」。
 *
 * 之所以提供它：让「渲染 → 导出」这条链路可以独立于 LLM 被验证和工作。
 */
export function buildLocalFallbackSpec(
  units: readonly ContentUnit[],
  sections: readonly string[],
  docType: 'resume' | 'cover-letter' = 'resume',
): DesignSpec {
  const isCover = docType === 'cover-letter';

  // 按板块归类单元，保持原文顺序
  const bySection = new Map<string, ContentUnit[]>();
  for (const s of sections) bySection.set(s, []);
  for (const u of units) {
    const list = bySection.get(u.section);
    if (list) list.push(u);
    else bySection.set(u.section, [u]);
  }

  return {
    version: 1,
    layout: {
      // 求职信的阅读路径必须是直线，强制单栏
      template: 'single-column',
      sectionOrder: [...bySection.keys()],
      density: isCover ? 'airy' : 'balanced',
    },
    theme: {
      palette: {
        primary: '#1F2937',
        accent: '#C9A227',
        text: '#111827',
        muted: '#6B7280',
        bg: '#FFFFFF',
      },
      fontPair: { heading: 'Calibri', body: 'Calibri' },
      scale: { h1: 1.6, h2: 1.25, body: 1, lineHeight: isCover ? 1.6 : 1.5 },
      ruleStyle: 'thin',
      cornerRadius: 0,
    },
    sections: [...bySection.entries()].map(([section, list]) => ({
      section,
      style: { emphasis: 'normal' as const },
      units: list.map((u) => ({ contentId: u.id })),
    })),
    rationale: '默认版式（未使用模型）。所有内容原样保留，未做任何设计判断。',
  };
}
