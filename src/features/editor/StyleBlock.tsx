/**
 * 风格选择（对应需求「板块功能 1/2」）。
 *
 * 预设与自定义不是二选一，而是**叠加**：
 * 选"金融"之后再补充"标题大一点"，两条都会送进 prompt。
 * 这一点必须让用户看得见，否则他会以为选了预设就不能再提要求。
 */

import { useState } from 'react';
import { Check, Palette } from 'lucide-react';
import type { DocType } from '@/core/store/workbench';
import { useWorkbenchStore } from '@/core/store/workbench';
import { findPreset, presetsFor } from '@/core/design/presets';
import { InputBlock } from './InputBlock';

export function StyleBlock({ type }: { type: DocType }) {
  const presetId = useWorkbenchStore((s) => s.inputs[type].presetId);
  const customStyle = useWorkbenchStore((s) => s.inputs[type].customStyle);
  const setPreset = useWorkbenchStore((s) => s.setPreset);
  const setCustomStyle = useWorkbenchStore((s) => s.setCustomStyle);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const presets = presetsFor(type);
  const selected = findPreset(presetId);
  // 视觉要点渲染在网格**外面**（见下方注释），所以这里要先把它找出来。
  const expandedPreset = presets.find((p) => p.id === expandedId) ?? null;

  return (
    <InputBlock
      index={6}
      title="视觉风格"
      hint="选一个预设作为起点，也可以在下面补充具体要求 —— 两者会叠加生效。"
      badge={
        <span className="text-[11px] text-ink-600">
          {selected ? selected.name : '未选择'}
        </span>
      }
    >
      {/*
        ── 预设卡片 ──

        ⚠ 卡片本体**必须等高**，所以「视觉要点」不在卡片里展开。
        曾经的写法是把要点列表渲染在卡片内部，结果展开的那一格被撑高，
        而同一行另一格高度不变 —— 四个方块看起来参差不齐。
        现在卡片只有「选择按钮 + 查看要点按钮」两层，高度由内容决定且彼此一致；
        要点统一在网格下方的面板里展示。
      */}
      <div className="grid gap-2 sm:grid-cols-2">
        {presets.map((p) => {
          const active = p.id === presetId;
          const expanded = expandedId === p.id;
          return (
            <div
              key={p.id}
              className={[
                'flex flex-col rounded-lg border transition-colors',
                active ? 'border-brand-500 bg-brand-500/5' : 'border-ink-800 hover:border-ink-700',
              ].join(' ')}
            >
              <button
                type="button"
                onClick={() => setPreset(type, active ? null : p.id)}
                className="flex w-full flex-1 items-start gap-2 p-2.5 text-left"
              >
                <span
                  className={[
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    active ? 'border-brand-500 bg-brand-500' : 'border-ink-600',
                  ].join(' ')}
                  aria-hidden="true"
                >
                  {active ? <Check size={11} className="text-on-accent" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={[
                      'block text-sm font-medium',
                      active ? 'text-brand-400' : 'text-ink-200',
                    ].join(' ')}
                  >
                    {p.name}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-400">
                    {p.tagline}
                  </span>
                </span>
              </button>

              <button
                type="button"
                onClick={() => setExpandedId(expanded ? null : p.id)}
                aria-expanded={expanded}
                className={[
                  'mt-auto w-full border-t px-2.5 py-1 text-left text-[10px] transition-colors',
                  expanded
                    ? 'border-brand-500/40 text-ink-400'
                    : 'border-ink-800 text-ink-600 hover:text-ink-400',
                ].join(' ')}
              >
                {expanded ? '收起视觉要点' : '查看视觉要点'}
              </button>
            </div>
          );
        })}
      </div>

      {/* ── 视觉要点（网格外的独立面板，切换预设时原位替换） ── */}
      {expandedPreset ? (
        <div className="mt-2 rounded-lg border border-ink-800 bg-ink-950/50 p-2.5">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-ink-300">
            <Palette size={12} />
            {expandedPreset.name} · 视觉要点
          </p>
          <ul className="space-y-1">
            {expandedPreset.hints.map((h, i) => (
              <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed text-ink-400">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-600" />
                <span className="min-w-0">{h}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── 自定义风格 ── */}
      <div className="mt-4">
        <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-300">
          <Palette size={13} />
          自定义风格要求
          {selected ? (
            <span className="font-normal text-ink-600">
              （附加在「{selected.name}」之上，若冲突以这里为准）
            </span>
          ) : null}
        </label>
        <textarea
          className="field min-h-[80px] resize-y text-[13px] leading-relaxed"
          placeholder={
            '用自然语言描述你想要的视觉效果，例如：\n'
            + '· 主色用深墨绿，不要红色\n'
            + '· 左侧留一条窄边栏放联系方式\n'
            + '· 希望打印成黑白后层级依然清楚\n'
            + '· 标题字体想要衬线，正文用无衬线'
          }
          value={customStyle}
          onChange={(e) => setCustomStyle(type, e.target.value)}
        />
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-600">
          描述得越具体越好。这里只能影响**版式与视觉**，
          写在这里的内容不会被当成正文 —— 正文请填在方块 1。
        </p>
      </div>

      {!selected && customStyle.trim().length === 0 ? (
        <p className="mt-3 rounded-lg border border-ink-800 bg-ink-950/50 p-2.5 text-[11px] leading-relaxed text-ink-600">
          还没选风格。不选也可以生成 —— 模型会自行判断一套适合
          {type === 'resume' ? '简历' : '求职信'}的专业版式。
        </p>
      ) : null}
    </InputBlock>
  );
}
