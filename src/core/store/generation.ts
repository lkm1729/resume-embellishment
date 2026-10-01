/**
 * 生成状态管理。
 *
 * 负责把「内容单元 + 风格要求 + 供应商/模型」变成一份 DesignSpec，
 * 并如实记录**这次生成用的是什么**——对应需求里的视觉效果1：
 * 生成按钮旁要显示供应商 / 模型名称（接口协议）/ 生成时间。
 *
 * 记录这些不只是为了好看：用户往往配了多个模型，
 * 过几天回看一份满意的简历时，"这是哪个模型生成的"是必须能回答的问题。
 */

import { create } from 'zustand';
import type { DocType } from './workbench';
import { useWorkbenchStore } from './workbench';
import type { DesignSpec } from '@/core/design/spec';
import { NO_FONT_OVERRIDE, type FontOverride } from '@/core/design/spec';
import { generateDesignSpec, type GenerationOutcome } from '@/core/design/generate';
import { createTauriChatClient, TransportLog } from '@/core/llm/chat-client';
import type { ModelSettings, Protocol } from '@/core/llm/types';
import { toCommandError } from '@/core/llm/types';
import { imagesAllowed, resolveCapabilities } from '@/core/llm/model-settings';
import { newHistoryId } from '@/core/history/api';
import { useHistoryStore } from '@/core/history/store';

/** 一次生成所用的模型信息。展示在生成按钮旁。 */
export interface RunInfo {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  protocol: Protocol;
  at: number;
}

export type GenerationStatus = 'idle' | 'generating' | 'done' | 'error';

/** 一次调整尝试的记录。用于让用户看到"改过哪几轮"。 */
export interface RefineAttempt {
  /** 用户原话。 */
  instruction: string;
  at: number;
  ok: boolean;
  /** 失败原因（成功时为空）。 */
  error?: string;
}

/** 生成目标（供应商 / 模型 / 能力）。 */
export interface GenerateTarget {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  protocol: Protocol;
  capabilities?: import('@/core/llm/types').Capabilities | undefined;
  /**
   * 这个模型的自定义参数（温度 / 思考强度 / 结构化输出 / 多模态）。
   *
   * 从 `ModelEntry.settings` 一路带进来，而不是在发起处现查供应商配置：
   * 发起生成时用的是**当时**选中的那个模型，配置随后被改不该影响这一轮。
   */
  settings?: ModelSettings | undefined;
}

interface GenerationState {
  status: Record<DocType, GenerationStatus>;
  spec: Record<DocType, DesignSpec | null>;
  run: Record<DocType, RunInfo | null>;
  /** 上一次生成的结果详情（含走了哪层策略、是否兜底）。 */
  outcome: Record<DocType, GenerationOutcome | null>;
  /** 错误信息（中文，可直接展示）。 */
  error: Record<DocType, string | null>;
  /** 传输层降级说明（端点不支持结构化输出时）。 */
  downgrade: Record<DocType, string | null>;
  /** 调整历史。**只增不减**，用户的每次尝试都留痕。 */
  refinements: Record<DocType, RefineAttempt[]>;
  /**
   * 上一版 spec 的栈（用于撤销一轮调整）。
   *
   * 只压入**被调整覆盖掉**的那些版本。栈本身不展示给用户，
   * 只服务于「撤销」这一个动作 —— 做成可视化的版本树需要
   * 一份能命名、能对比的界面，那是另一个功能。
   */
  specStack: Record<DocType, DesignSpec[]>;

  /**
   * 用户手工指定的字体，覆盖版式自带的那对。
   *
   * 刻意**单独存**、不写进 `spec`：`spec` 要能被原样发回模型做「继续调整」，
   * 而它必须通过 `z.enum(FONT_WHITELIST)` 校验。用户从本机字体里挑的
   * 名字（`华文行楷`之类）不在白名单里，一旦写进 spec，下一轮调整
   * 就会因校验失败整轮报错，且报错内容完全看不出跟字体有关。
   *
   * 因此它是一层**渲染/导出前**的覆盖，`spec` 本身始终干净。
   * `null` 表示"这一项跟随版式"。
   */
  fontOverride: Record<DocType, FontOverride>;

  generate: (type: DocType, target: GenerateTarget) => Promise<void>;

  /**
   * 在现有版式上继续调整。
   *
   * 与 `generate` 的关键区别：它把**当前 spec** 一起发给模型，
   * 并要求只改用户指出的部分。没有当前 spec 时（还没生成过）
   * 应当走 `generate` —— 这里会直接拒绝，而不是悄悄降级成重新生成。
   */
  refine: (type: DocType, target: GenerateTarget, instruction: string) => Promise<boolean>;

  /** 直接套用一份 spec（本地兜底、历史回滚都走这里）。 */
  applySpec: (type: DocType, spec: DesignSpec, run?: RunInfo | null) => void;
  /** 换掉某一项的字体；传 `null` 表示跟随版式。 */
  setFontOverride: (type: DocType, override: FontOverride) => void;
  clear: (type: DocType) => void;
  /** 撤销最后一轮调整，退回上一版 spec。 */
  undoRefinement: (type: DocType) => void;
}

const idle = <T,>(v: T): Record<DocType, T> => ({
  resume: v,
  'cover-letter': v,
});

export const useGenerationStore = create<GenerationState>((set, get) => ({
  status: idle<GenerationStatus>('idle'),
  spec: idle<DesignSpec | null>(null),
  run: idle<RunInfo | null>(null),
  outcome: idle<GenerationOutcome | null>(null),
  error: idle<string | null>(null),
  downgrade: idle<string | null>(null),
  refinements: idle<RefineAttempt[]>([]),
  specStack: idle<DesignSpec[]>([]),
  fontOverride: idle<FontOverride>(NO_FONT_OVERRIDE),

  async generate(type, target) {
    const wb = useWorkbenchStore.getState();
    const parsed = wb.parsed[type];

    if (!parsed || parsed.units.length === 0) {
      set({
        status: { ...get().status, [type]: 'error' },
        error: { ...get().error, [type]: '请先在方块 1 填入正文。' },
      });
      return;
    }

    set({
      status: { ...get().status, [type]: 'generating' },
      error: { ...get().error, [type]: null },
      downgrade: { ...get().downgrade, [type]: null },
    });

    const log = new TransportLog();
    // 温度与思考强度由客户端注入，编排层完全不必知道它们存在
    const client = createTauriChatClient(target.providerId, target.modelId, log, target.settings);

    try {
      const outcome = await generateDesignSpec(client, {
        units: parsed.units,
        sections: parsed.sections,
        input: wb.inputs[type],
        docType: type,
        // 用户的结构化输出开关盖在探测结果上；不填则原样透传
        capabilities: resolveCapabilities(target.capabilities, target.settings),
        allowImages: imagesAllowed(target.settings),
      });

      if (!outcome.ok || !outcome.spec) {
        set({
          status: { ...get().status, [type]: 'error' },
          error: { ...get().error, [type]: outcome.error ?? '生成失败。' },
          outcome: { ...get().outcome, [type]: outcome },
        });
        return;
      }

      const runInfo: RunInfo = {
        providerId: target.providerId,
        providerName: target.providerName,
        modelId: target.modelId,
        modelName: target.modelName,
        protocol: target.protocol,
        at: Date.now(),
      };

      set({
        status: { ...get().status, [type]: 'done' },
        spec: { ...get().spec, [type]: outcome.spec },
        run: { ...get().run, [type]: runInfo },
        outcome: { ...get().outcome, [type]: outcome },
        downgrade: {
          ...get().downgrade,
          [type]: log.latest?.note ?? null,
        },
        // 从零重新生成：旧的撤消栈与调整记录都不再对应任何东西了。
        // 留着它们会让「撤销」退回一个用户已经主动放弃的版式。
        specStack: { ...get().specStack, [type]: [] },
        refinements: { ...get().refinements, [type]: [] },
      });

      // 存历史快照。
      //
      // 存**完整快照**而不是成品文件：回滚需要能重建排版，
      // 而 PDF 是重建不出来的。渲染层是纯函数，
      // 所以"快照 → 重放 → 与原图一致"是成立的。
      //
      // 存历史失败不应让生成结果作废 —— 用户已经拿到了可用的版式，
      // 这时弹一个错误只会让人困惑。因此单独捕获。
      try {
        await useHistoryStore.getState().save({
          id: newHistoryId(),
          docType: type,
          createdAt: runInfo.at,
          providerName: runInfo.providerName,
          modelName: runInfo.modelName,
          protocol: runInfo.protocol,
          designSpec: outcome.spec,
          contentSnapshot: [...parsed.units],
          contentHash: parsed.contentHash,
          ...(outcome.usedConservativeFallback
            ? { note: '由保守兜底版式生成（模型多次未产出合法结构）' }
            : {}),
        });
      } catch (e) {
        console.warn('[generation] 保存历史记录失败：', e);
      }
    } catch (e) {
      set({
        status: { ...get().status, [type]: 'error' },
        error: { ...get().error, [type]: toCommandError(e).message },
      });
    }
  },

  /**
   * 在现有版式上继续调整。
   *
   * 与 `generate` 共用大部分执行路径，但有三点必须不同：
   *   1. 提示词里带上**当前 spec**，并要求只改被指出的部分；
   *   2. 失败时**保留原 spec** —— 一次没改好不该让用户失去已经满意的版本；
   *   3. 成功时把旧版压栈，让「撤销」有东西可退。
   */
  async refine(type, target, instruction) {
    const wb = useWorkbenchStore.getState();
    const parsed = wb.parsed[type];
    const current = get().spec[type];
    const text = instruction.trim();

    if (text.length === 0) {
      set({
        status: { ...get().status, [type]: 'error' },
        error: { ...get().error, [type]: '请写下你想怎么调整。' },
      });
      return false;
    }

    if (!current) {
      set({
        status: { ...get().status, [type]: 'error' },
        error: {
          ...get().error,
          [type]: '还没有可调整的版式。请先点「生成版式」。',
        },
      });
      return false;
    }

    if (!parsed || parsed.units.length === 0) {
      set({
        status: { ...get().status, [type]: 'error' },
        error: { ...get().error, [type]: '请先在方块 1 填入正文。' },
      });
      return false;
    }

    const record = (ok: boolean, err?: string) => {
      const next: RefineAttempt = {
        instruction: text,
        at: Date.now(),
        ok,
        ...(err ? { error: err } : {}),
      };
      set({ refinements: { ...get().refinements, [type]: [...get().refinements[type], next] } });
    };

    set({
      status: { ...get().status, [type]: 'generating' },
      error: { ...get().error, [type]: null },
      downgrade: { ...get().downgrade, [type]: null },
    });

    const log = new TransportLog();
    const client = createTauriChatClient(target.providerId, target.modelId, log, target.settings);

    try {
      const outcome = await generateDesignSpec(client, {
        units: parsed.units,
        sections: parsed.sections,
        input: wb.inputs[type],
        docType: type,
        capabilities: resolveCapabilities(target.capabilities, target.settings),
        allowImages: imagesAllowed(target.settings),
        refine: { spec: current, instruction: text },
      });

      if (!outcome.ok || !outcome.spec) {
        const message = outcome.error ?? '调整失败。';
        // ⚠ 保留原 spec：改坏了不等于原来的也不能用了。
        set({
          status: { ...get().status, [type]: 'error' },
          error: {
            ...get().error,
            [type]: `${message}\n\n（原来的版式没有被改动，可以继续用。）`,
          },
          outcome: { ...get().outcome, [type]: outcome },
        });
        record(false, message);
        return false;
      }

      set({
        status: { ...get().status, [type]: 'done' },
        spec: { ...get().spec, [type]: outcome.spec },
        specStack: { ...get().specStack, [type]: [...get().specStack[type], current] },
        outcome: { ...get().outcome, [type]: outcome },
        downgrade: { ...get().downgrade, [type]: log.latest?.note ?? null },
      });
      record(true);

      // 调整结果也存历史 —— 用户会想回到"第二版那个更好的样子"。
      const run = get().run[type];
      if (run) {
        try {
          await useHistoryStore.getState().save({
            id: newHistoryId(),
            docType: type,
            createdAt: Date.now(),
            providerName: run.providerName,
            modelName: run.modelName,
            protocol: run.protocol,
            designSpec: outcome.spec,
            contentSnapshot: [...parsed.units],
            contentHash: parsed.contentHash,
            note: `调整：${text.length > 60 ? `${text.slice(0, 60)}…` : text}`,
          });
        } catch (e) {
          console.warn('[generation] 保存调整历史失败：', e);
        }
      }

      return true;
    } catch (e) {
      const message = toCommandError(e).message;
      set({
        status: { ...get().status, [type]: 'error' },
        error: {
          ...get().error,
          [type]: `${message}\n\n（原来的版式没有被改动，可以继续用。）`,
        },
      });
      record(false, message);
      return false;
    }
  },

  /**
   * 撤销最后一轮调整。
   *
   * 只退一格，不退到最初 —— 「撤销」的语义是逐步回退，
   * 一次弹回开头会让人分不清自己退到了哪一版。
   */
  undoRefinement(type) {
    const stack = get().specStack[type];
    const previous = stack[stack.length - 1];
    if (!previous) return;

    set({
      spec: { ...get().spec, [type]: previous },
      specStack: { ...get().specStack, [type]: stack.slice(0, -1) },
      // 调整记录也退一格，否则"改过三轮"与实际版式对不上。
      refinements: {
        ...get().refinements,
        [type]: get().refinements[type].slice(0, -1),
      },
      error: { ...get().error, [type]: null },
    });
  },

  applySpec(type, spec, run = null) {
    set({
      status: { ...get().status, [type]: 'done' },
      spec: { ...get().spec, [type]: spec },
      run: { ...get().run, [type]: run },
      error: { ...get().error, [type]: null },
    });
  },

  setFontOverride(type, override) {
    // 两个字段都没设时回落到那个共享常量，而不是每次新建一个
    // `{ heading: null, body: null }` —— 渲染层用引用比较来判断
    // "要不要重排"，每次都给新对象会让整篇预览白重算。
    const next =
      override.heading === null && override.body === null ? NO_FONT_OVERRIDE : override;

    // 内容没变就不 set：否则选择器每点一次同一个字体都会触发一轮重渲染。
    const current = get().fontOverride[type];
    if (current.heading === next.heading && current.body === next.body) return;

    set({ fontOverride: { ...get().fontOverride, [type]: next } });
  },

  clear(type) {
    set({
      status: { ...get().status, [type]: 'idle' },
      spec: { ...get().spec, [type]: null },
      run: { ...get().run, [type]: null },
      outcome: { ...get().outcome, [type]: null },
      error: { ...get().error, [type]: null },
      downgrade: { ...get().downgrade, [type]: null },
      refinements: { ...get().refinements, [type]: [] },
      specStack: { ...get().specStack, [type]: [] },
      fontOverride: { ...get().fontOverride, [type]: NO_FONT_OVERRIDE },
    });
  },
}));
