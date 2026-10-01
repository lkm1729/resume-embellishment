/**
 * 单个模型的自定义参数：取值校验与「三态覆盖」的解析。
 *
 * 为什么单开一个模块：这套规则有两个必须一致的使用方 ——
 * 设置界面（决定这个值能不能存）和生成链路（决定这个值怎么用）。
 * 如果 UI 允许存下一个上层用不了的值，用户会看到「设置保存了但没生效」，
 * 而那种失败没有任何提示，最难查。
 */

import {
  REASONING_EFFORT_LABELS,
  type Capabilities,
  type ModelSettings,
  type ReasoningEffort,
} from './types';

/** 温度取值范围。取 OpenAI 的 [0, 2]；超出范围的值端点会直接报 400。 */
export const TEMPERATURE_MIN = 0;
export const TEMPERATURE_MAX = 2;

export type TemperatureParse =
  | { kind: 'empty' }
  | { kind: 'ok'; value: number }
  | { kind: 'invalid'; reason: string };

/**
 * 解析用户输入的温度。
 *
 * 单独抽出来是因为它有三种结果而不是两种：**空**不等于**非法**。
 * 空表示「不填，用端点默认值」，非法要挡住保存 —— 混为一谈的话，
 * 要么把清空当成错误拦住用户，要么把 `abc` 存进去。
 */
export function parseTemperature(raw: string): TemperatureParse {
  const text = raw.trim();
  if (text === '') return { kind: 'empty' };

  const value = Number(text);
  if (!Number.isFinite(value)) return { kind: 'invalid', reason: '温度得是个数字。' };
  if (value < TEMPERATURE_MIN || value > TEMPERATURE_MAX) {
    return {
      kind: 'invalid',
      reason: `温度需要在 ${TEMPERATURE_MIN} 到 ${TEMPERATURE_MAX} 之间。`,
    };
  }
  return { kind: 'ok', value };
}

/** 这个模型是否设过任何参数（用来决定要不要显示小标记）。 */
export function hasAnySetting(settings: ModelSettings | undefined): boolean {
  if (!settings) return false;
  return (
    settings.temperature !== undefined ||
    settings.reasoningEffort !== undefined ||
    settings.structuredOutput !== undefined ||
    settings.multimodal !== undefined
  );
}

/**
 * 去掉空字段；什么都没剩时返回 `undefined`。
 *
 * `exactOptionalPropertyTypes` 下不能拿 `undefined` 赋值给可选属性，
 * 所以不是「清空后得到 `{temperature: undefined}`」，而是**整个字段消失**。
 * 这同时让存盘结果保持干净：没设过参数的模型不会多出一个 `"settings": {}`。
 */
export function normalizeSettings(settings: ModelSettings): ModelSettings | undefined {
  const out: ModelSettings = {};

  if (typeof settings.temperature === 'number' && Number.isFinite(settings.temperature)) {
    out.temperature = settings.temperature;
  }
  if (settings.reasoningEffort !== undefined) out.reasoningEffort = settings.reasoningEffort;
  if (settings.structuredOutput !== undefined) out.structuredOutput = settings.structuredOutput;
  if (settings.multimodal !== undefined) out.multimodal = settings.multimodal;

  return hasAnySetting(out) ? out : undefined;
}

/**
 * 把用户的结构化输出开关盖到探测结果上。
 *
 * 三态：不填（`undefined`）原样返回探测结果 —— 这是默认，
 * 意味着「别替我决定」，探测说什么就是什么。
 *
 * ⚠ 关掉的时候必须**连 `jsonObject` 一起关**。只关 `jsonSchema` 的话，
 * `planStrategies` 还会排出「JSON 模式 + 提示词内嵌 schema」那一层，
 * 用户的意图明明是「这个端点不认结构化参数，请用纯文本」。
 */
export function resolveCapabilities(
  caps: Capabilities | undefined,
  settings: ModelSettings | undefined,
): Capabilities | undefined {
  const override = settings?.structuredOutput;
  if (override === undefined) return caps;

  return {
    jsonSchema: override,
    jsonObject: override ? (caps?.jsonObject ?? false) : false,
    streaming: caps?.streaming ?? false,
    listModels: caps?.listModels ?? false,
  };
}

/**
 * 用户是否明确声明了这个模型不吃图片。
 *
 * 只有 `false` 才是不吃 —— 不填视为支持，保持与从前一致的行为。
 */
export function imagesAllowed(settings: ModelSettings | undefined): boolean {
  return settings?.multimodal !== false;
}

/**
 * 设置面板收起时显示的小标签。
 *
 * 顺序固定（温度 → 思考 → 结构化 → 多模态），不按用户填写的先后排 ——
 * 同一个模型每次展开都该看到同样的顺序，否则找起来要靠眼睛扫。
 */
export function settingsSummary(settings: ModelSettings | undefined): string[] {
  if (!settings) return [];

  const tags: string[] = [];
  if (settings.temperature !== undefined) tags.push(`温度 ${settings.temperature}`);
  if (settings.reasoningEffort !== undefined) {
    tags.push(`思考 ${REASONING_EFFORT_LABELS[settings.reasoningEffort]}`);
  }
  if (settings.structuredOutput !== undefined) {
    tags.push(settings.structuredOutput ? '结构化输出' : '不用结构化输出');
  }
  if (settings.multimodal !== undefined) {
    tags.push(settings.multimodal ? '支持图片' : '不下发图片');
  }
  return tags;
}

/** 运行期校验：从存盘文件读回来的值可能是手改过的。 */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && value in REASONING_EFFORT_LABELS;
}
