/**
 * 把 Rust 的生成命令适配成 `ChatClient`。
 *
 * 为什么要这层薄适配：`core/design/generate.ts` 里的编排逻辑
 * 只依赖一个 `chat(req) → string` 的窄接口。
 * 这样单元测试可以塞假客户端，而生产环境接真实的 Tauri 命令 ——
 * 两边共用同一套回退与校验逻辑，不会出现"测试里是好的、实际跑不通"。
 */

import * as api from './api';
import { toCommandError } from './types';
import type { ModelSettings } from './types';
import type { ChatClient, ChatRequest } from '@/core/design/generate';
import { DESIGN_SPEC_JSON_SCHEMA } from '@/core/design/spec';

/** 最近一次生成中框架层的降级说明（供 UI 如实展示端点能力）。 */
export interface DowngradeReport {
  note: string;
  at: number;
}

/**
 * 观察一次生成的传输层信息。
 *
 * 单独用一个对象收集，而不是改 `ChatClient` 的返回类型 ——
 * 编排逻辑不该关心传输层细节，但 UI 需要知道"端点实际走到了哪一层"。
 */
export class TransportLog {
  private notes: DowngradeReport[] = [];

  record(note: string): void {
    this.notes.push({ note, at: Date.now() });
  }

  get all(): readonly DowngradeReport[] {
    return this.notes;
  }

  /** 取最后一次降级说明，UI 通常只展示这个。 */
  get latest(): DowngradeReport | undefined {
    return this.notes.at(-1);
  }

  clear(): void {
    this.notes = [];
  }
}

/**
 * 造一个连到真实后端的生成客户端。
 *
 * @param providerId 供应商 id
 * @param modelId    模型 id
 * @param log        传输层日志（可选）
 * @param settings   这个模型的自定义参数（可选）
 *
 * 采样参数（温度 / 思考强度）在这里注入，而不是让 `generate.ts`
 * 把它们塞进每一次 `chat()` 调用：编排层要回答的是「要什么策略、
 * 拿回什么文本」，采样参数属于传输细节。放这里还顺带保证了
 * 修复轮与兜底轮用的是同一套参数 —— 那几轮若用了不同温度，
 * 「上次是坏的、这次是好的」就说不清了。
 */
export function createTauriChatClient(
  providerId: string,
  modelId: string,
  log?: TransportLog,
  settings?: ModelSettings,
): ChatClient {
  return {
    async chat(req: ChatRequest): Promise<string> {
      try {
        const res = await api.generateDesignSpec(providerId, modelId, {
          system: req.system,
          user: req.user,
          strategy: req.strategy,
          // json_schema 策略需要把 schema 下发给端点；
          // 其余策略靠 prompt 里内嵌的 schema（buildSystemPrompt 已包含）
          ...(req.strategy === 'json_schema'
            ? { jsonSchema: DESIGN_SPEC_JSON_SCHEMA }
            : {}),
          // 图片是独立的多模态分段，不是 prompt 文本的一部分。
          // 为空时不带该字段，让请求体与从前逐字一致。
          ...(req.images && req.images.length > 0 ? { images: [...req.images] } : {}),
          // 没设过就一个键都不加：请求体与从前逐字一致。
          // 这两项都是「用户显式要求才发」—— 尤其思考强度，
          // 不认它的端点收到这个字段会直接 400。
          ...(settings?.temperature !== undefined
            ? { temperature: settings.temperature }
            : {}),
          ...(settings?.reasoningEffort !== undefined
            ? { reasoningEffort: settings.reasoningEffort }
            : {}),
        });

        // 端点拒绝了结构化参数、框架层降级时，如实记录
        if (res.downgradeNote && log) {
          log.record(res.downgradeNote);
        }

        return res.text;
      } catch (e) {
        // 转成带中文说明的错误，让上层的失败分类能给出可操作建议
        throw new Error(toCommandError(e).message);
      }
    },
  };
}
