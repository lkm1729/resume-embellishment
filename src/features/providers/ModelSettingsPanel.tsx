/**
 * 单个模型的自定义参数面板。
 *
 * 这些是**进阶设置**，默认全部留空 —— 不填就是「不要替我决定」，
 * 请求体与从前逐字一致。所以面板的第一要务不是让人填，
 * 而是让人看懂「留空会怎样」，否则用户会以为必须每项都设一个值。
 *
 * 三项高级开关的语义差别，也是这里必须写清楚的东西：
 *   - 温度、思考强度：留空 = **不发送这个参数**（不是发一个默认值）
 *   - 结构化输出：留空 = 跟随连通性探测结果（三态里的一态）
 *   - 多模态：留空 = 允许发送图片
 */

import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  REASONING_EFFORTS,
  REASONING_EFFORT_LABELS,
  type ModelSettings,
  type ReasoningEffort,
} from '@/core/llm/types';
import {
  normalizeSettings,
  parseTemperature,
  settingsSummary,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
} from '@/core/llm/model-settings';

/**
 * 一次改动。用 `null` 表示「清掉这一项」，而不是 `undefined` ——
 * 项目开了 `exactOptionalPropertyTypes`，可选属性不能显式赋 `undefined`，
 * 用 `null` 当哨兵可以让「不改」「改成某值」「清掉」三件事各有一个明确的写法。
 */
type Patch = {
  temperature?: number | null;
  reasoningEffort?: ReasoningEffort | null;
  structuredOutput?: boolean | null;
  multimodal?: boolean | null;
};

export function ModelSettingsPanel({
  settings,
  onChange,
}: {
  settings: ModelSettings | undefined;
  /** 传 `undefined` 表示这个模型没有任何自定义参数（键会整个消失）。 */
  onChange: (next: ModelSettings | undefined) => void;
}) {
  // 温度输入框的文本要在本地留一份：用户打到一半的 `0.` 或空串
  // 都不是合法数字，直接由 props 驱动的话会把光标里的内容擦掉。
  const [tempText, setTempText] = useState(
    settings?.temperature !== undefined ? String(settings.temperature) : '',
  );

  const parsed = parseTemperature(tempText);

  const apply = (patch: Patch) => {
    const pick = <T,>(key: keyof Patch, fallback: T | null): T | null =>
      key in patch ? (patch[key] as T | null) : fallback;

    const next: ModelSettings = {};

    const temperature = pick<number>('temperature', settings?.temperature ?? null);
    if (typeof temperature === 'number') next.temperature = temperature;

    const effort = pick<ReasoningEffort>('reasoningEffort', settings?.reasoningEffort ?? null);
    if (effort !== null) next.reasoningEffort = effort;

    const structured = pick<boolean>('structuredOutput', settings?.structuredOutput ?? null);
    if (structured !== null) next.structuredOutput = structured;

    const multimodal = pick<boolean>('multimodal', settings?.multimodal ?? null);
    if (multimodal !== null) next.multimodal = multimodal;

    onChange(normalizeSettings(next));
  };

  const onTempInput = (raw: string) => {
    setTempText(raw);
    const p = parseTemperature(raw);
    if (p.kind === 'ok') apply({ temperature: p.value });
    // 清空即「不填」——不是错误，也不该把上一个值悄悄留着
    else if (p.kind === 'empty') apply({ temperature: null });
  };

  const summary = settingsSummary(settings);

  return (
    <div className="space-y-3 rounded-lg border border-ink-800 bg-ink-950/40 p-3">
      {/* ── 温度 ── */}
      <Row
        label="温度"
        hint={`${TEMPERATURE_MIN} 到 ${TEMPERATURE_MAX}。越低越稳定，越高越发散。留空则用端点默认值。`}
      >
        <div className="flex items-center gap-2">
          <input
            className="field w-24 text-xs"
            inputMode="decimal"
            placeholder="默认"
            value={tempText}
            onChange={(e) => onTempInput(e.target.value)}
            aria-label="温度"
            aria-invalid={parsed.kind === 'invalid'}
          />
          {tempText !== '' ? (
            <button
              type="button"
              onClick={() => {
                setTempText('');
                apply({ temperature: null });
              }}
              className="text-[11px] text-ink-500 transition-colors hover:text-ink-300"
            >
              清空
            </button>
          ) : null}
        </div>
        {parsed.kind === 'invalid' ? (
          <p className="mt-1 text-[11px] text-warn-300">{parsed.reason}</p>
        ) : null}
      </Row>

      {/* ── 思考强度 ── */}
      <Row
        label="思考强度"
        hint="只有部分端点认这个参数。留空就完全不发送 —— 端点不认却收到了，会直接报错。"
      >
        <select
          className="field w-40 appearance-none text-xs"
          value={settings?.reasoningEffort ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            apply({ reasoningEffort: v === '' ? null : (v as ReasoningEffort) });
          }}
          aria-label="思考强度"
        >
          <option value="">跟随端点默认</option>
          {REASONING_EFFORTS.map((effort) => (
            <option key={effort} value={effort}>
              {REASONING_EFFORT_LABELS[effort]}（{effort}）
            </option>
          ))}
        </select>
      </Row>

      {/* ── 结构化输出 ── */}
      <Row
        label="结构化输出"
        hint="这个模型能不能按 JSON Schema 输出。探测偶尔会误判（端点换了实现、或探测时正好限流），所以给你一个手动覆盖。"
      >
        <TriState
          label="结构化输出"
          value={settings?.structuredOutput}
          autoLabel="跟随探测"
          onLabel="强制开启"
          offLabel="关闭"
          onChange={(v) => apply({ structuredOutput: v })}
        />
      </Row>

      {/* ── 多模态 ── */}
      <Row
        label="多模态"
        hint="关掉之后，参考图不会再随请求发出去（生成时会告诉你跳过了几张）。文字资料不受影响。"
      >
        <TriState
          label="多模态"
          value={settings?.multimodal}
          autoLabel="默认（可发图）"
          onLabel="支持图片"
          offLabel="不下发图片"
          onChange={(v) => apply({ multimodal: v })}
        />
      </Row>

      {/* ── 收尾：当前生效的参数 + 复位 ── */}
      <div className="flex flex-wrap items-center gap-2 border-t border-ink-800 pt-2.5">
        <span className="text-[11px] text-ink-600">
          {summary.length > 0 ? `当前：${summary.join(' · ')}` : '当前：全部跟随默认'}
        </span>
        {settings ? (
          <button
            type="button"
            onClick={() => {
              setTempText('');
              onChange(undefined);
            }}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-500 transition-colors hover:text-ink-300"
          >
            <RotateCcw size={11} />
            全部恢复默认
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 一行设置：左边标题 + 说明，右边控件。 */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-ink-300">{label}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-600">{hint}</p>
        </div>
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/**
 * 三态开关。
 *
 * 用三颗按钮而不是一个开关：这里真正有价值的选项有三个
 * （跟随探测 / 强制开 / 强制关），而开关只能表达两个。
 */
function TriState({
  label,
  value,
  autoLabel,
  onLabel,
  offLabel,
  onChange,
}: {
  label: string;
  value: boolean | undefined;
  autoLabel: string;
  onLabel: string;
  offLabel: string;
  onChange: (next: boolean | null) => void;
}) {
  const options: Array<{ key: string; text: string; active: boolean; next: boolean | null }> = [
    { key: 'auto', text: autoLabel, active: value === undefined, next: null },
    { key: 'on', text: onLabel, active: value === true, next: true },
    { key: 'off', text: offLabel, active: value === false, next: false },
  ];

  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-ink-700" role="group" aria-label={label}>
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.next)}
          aria-pressed={opt.active}
          className={`px-2.5 py-1 text-[11px] transition-colors ${
            opt.active
              ? 'bg-brand-500/15 text-brand-300'
              : 'text-ink-500 hover:bg-ink-800 hover:text-ink-300'
          }`}
        >
          {opt.text}
        </button>
      ))}
    </div>
  );
}
