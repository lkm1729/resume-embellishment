/**
 * 单个模型的自定义参数（V0.1.3 第 3 条）。
 *
 * 这里要钉住的不是「参数能不能存」，而是**三态**这件事：
 * 留空 = 不要替我决定，和「设成 false」「设成 0」是三件不同的事。
 * 一旦被简化成布尔开关，用户就没法表达「跟随探测」，
 * 也没法说明「这个端点不认思考强度这个参数，请一个字都别发」。
 */

import { describe, expect, it } from 'vitest';
import {
  hasAnySetting,
  imagesAllowed,
  isReasoningEffort,
  normalizeSettings,
  parseTemperature,
  resolveCapabilities,
  settingsSummary,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
} from './model-settings';
import type { Capabilities, ModelSettings } from './types';

const CAPS: Capabilities = {
  jsonSchema: true,
  jsonObject: true,
  streaming: true,
  listModels: true,
};

describe('parseTemperature', () => {
  it('空输入是「不填」，不是「非法」', () => {
    expect(parseTemperature('')).toEqual({ kind: 'empty' });
    // 用户删到只剩空格，同样是不填
    expect(parseTemperature('   ')).toEqual({ kind: 'empty' });
  });

  it('读得出正常温度', () => {
    expect(parseTemperature('0.7')).toEqual({ kind: 'ok', value: 0.7 });
  });

  it('0 是合法温度，不能被当成空', () => {
    // 用 `if (!value)` 之类的写法就会在这里出事：
    // 温度 0 是最常见的确定性设置，被吞掉的话用户完全看不出原因。
    expect(parseTemperature('0')).toEqual({ kind: 'ok', value: 0 });
  });

  it('两端端点值都算合法', () => {
    expect(parseTemperature(String(TEMPERATURE_MIN))).toEqual({ kind: 'ok', value: 0 });
    expect(parseTemperature(String(TEMPERATURE_MAX))).toEqual({ kind: 'ok', value: 2 });
  });

  it('非数字被挡住，并给出理由', () => {
    const r = parseTemperature('abc');
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.reason).toContain('数字');
  });

  it('超出范围被挡住 —— 越界的温度端点会直接 400', () => {
    expect(parseTemperature('2.1').kind).toBe('invalid');
    expect(parseTemperature('-0.1').kind).toBe('invalid');
  });
});

describe('normalizeSettings', () => {
  it('什么都没设得到 undefined（整个键消失，不留空对象）', () => {
    expect(normalizeSettings({})).toBeUndefined();
  });

  it('只留下设过的字段', () => {
    const out = normalizeSettings({ temperature: 0.7 });
    expect(out).toEqual({ temperature: 0.7 });
    // 关键：不是 `{temperature: 0.7, reasoningEffort: undefined}`。
    // exactOptionalPropertyTypes 下那种对象存盘会多写几个 null。
    expect(out && 'reasoningEffort' in out).toBe(false);
    expect(out && 'multimodal' in out).toBe(false);
  });

  it('温度为 0 不会被当成空丢掉', () => {
    expect(normalizeSettings({ temperature: 0 })).toEqual({ temperature: 0 });
  });

  it('NaN 温度被丢掉', () => {
    expect(normalizeSettings({ temperature: Number.NaN })).toBeUndefined();
  });

  it('false 是有意义的值，不能被当成空', () => {
    expect(normalizeSettings({ structuredOutput: false })).toEqual({
      structuredOutput: false,
    });
    expect(normalizeSettings({ multimodal: false })).toEqual({ multimodal: false });
  });
});

describe('resolveCapabilities', () => {
  it('没设过时原样返回探测结果 —— 连引用都不换', () => {
    // 引用相等是刻意的：上层拿它当 memo 依赖，
    // 每次生成都换一个新对象会让「同样的探测结果」看起来像变了。
    expect(resolveCapabilities(CAPS, undefined)).toBe(CAPS);
    expect(resolveCapabilities(CAPS, { temperature: 0.7 })).toBe(CAPS);
  });

  it('强制开启时打开 jsonSchema，其余探测项保留', () => {
    const out = resolveCapabilities(
      { jsonSchema: false, jsonObject: true, streaming: true, listModels: false },
      { structuredOutput: true },
    );
    expect(out).toEqual({
      jsonSchema: true,
      jsonObject: true,
      streaming: true,
      listModels: false,
    });
  });

  it('关掉时连 jsonObject 一起关', () => {
    // 只关 jsonSchema 的话，planStrategies 还会排出
    // 「JSON 模式 + 提示词内嵌 schema」那一层 —— 而用户的意图
    // 恰恰是「这个端点不认结构化参数，请用纯文本」。
    expect(resolveCapabilities(CAPS, { structuredOutput: false })).toEqual({
      jsonSchema: false,
      jsonObject: false,
      streaming: true,
      listModels: true,
    });
  });

  it('没有探测结果也能被强制开启', () => {
    expect(resolveCapabilities(undefined, { structuredOutput: true })).toEqual({
      jsonSchema: true,
      jsonObject: false,
      streaming: false,
      listModels: false,
    });
  });
});

describe('imagesAllowed', () => {
  it('不填视为支持，保持与从前一致', () => {
    expect(imagesAllowed(undefined)).toBe(true);
    expect(imagesAllowed({})).toBe(true);
    expect(imagesAllowed({ multimodal: true })).toBe(true);
  });

  it('只有明确说不吃图片才不下发', () => {
    expect(imagesAllowed({ multimodal: false })).toBe(false);
  });
});

describe('settingsSummary', () => {
  it('没设过就没有标签', () => {
    expect(settingsSummary(undefined)).toEqual([]);
    expect(settingsSummary({})).toEqual([]);
  });

  it('顺序固定，不跟字段书写顺序走', () => {
    const settings: ModelSettings = {
      multimodal: false,
      structuredOutput: false,
      reasoningEffort: 'high',
      temperature: 0.7,
    };
    expect(settingsSummary(settings)).toEqual([
      '温度 0.7',
      '思考 高',
      '不用结构化输出',
      '不下发图片',
    ]);
  });
});

describe('hasAnySetting / isReasoningEffort', () => {
  it('温度为 0 也算设过', () => {
    expect(hasAnySetting(undefined)).toBe(false);
    expect(hasAnySetting({})).toBe(false);
    expect(hasAnySetting({ temperature: 0 })).toBe(true);
  });

  it('认得出合法档位，认不出别的', () => {
    expect(isReasoningEffort('high')).toBe(true);
    expect(isReasoningEffort('none')).toBe(true);
    // 手改过 providers.json 的值会走到这里
    expect(isReasoningEffort('ultra')).toBe(false);
    expect(isReasoningEffort(undefined)).toBe(false);
    expect(isReasoningEffort(3)).toBe(false);
  });
});
