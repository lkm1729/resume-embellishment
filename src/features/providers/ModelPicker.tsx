/**
 * 模型选择器。
 *
 * 需求：一键拉取可用模型列表，可搜索筛选、可多选、可全选。
 * 模型列表动辄几百条，因此搜索与虚拟化友好性是关键；
 * 这里用「搜索 + 全选当前筛选结果」的组合，比单纯全选更实用
 * —— 用户常常只想批量添加某一类（如全部 claude-*）。
 */

import { useMemo, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import type { ModelInfo } from '@/core/llm/types';
import { searchModels } from '@/core/llm/search';
import { OrbitSpinner } from '@/components/effects';

export function ModelPicker({
  models,
  selected,
  onSelectedChange,
  onClose,
  loading,
}: {
  models: readonly ModelInfo[];
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  onClose: () => void;
  loading?: boolean;
}) {
  const [query, setQuery] = useState('');

  const visible = useMemo(() => searchModels(models, { query }), [models, query]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  };

  /** 全选当前**筛选结果**，而非全部 —— 配合搜索可实现"批量加某一类"。 */
  const selectAllVisible = () => {
    const next = new Set(selected);
    for (const m of visible) next.add(m.id);
    onSelectedChange(next);
  };

  const clearVisible = () => {
    const next = new Set(selected);
    for (const m of visible) next.delete(m.id);
    onSelectedChange(next);
  };

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900">
      <div className="flex items-center gap-2 border-b border-ink-800 p-2.5">
        <div className="relative min-w-0 flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-600"
          />
          <input
            className="field pl-8"
            placeholder="搜索模型 ID 或归属方…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-2 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-200"
          aria-label="关闭"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex items-center justify-between gap-2 border-b border-ink-800 px-2.5 py-2">
        <span className="text-[11px] text-ink-400">
          {loading ? '加载中…' : `共 ${models.length} 个，当前显示 ${visible.length} 个`}
          {selected.size > 0 ? ` · 已选 ${selected.size} 个` : ''}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={selectAllVisible}
            disabled={visible.length === 0}
            className="rounded px-2 py-1 text-[11px] text-brand-400 transition-colors hover:bg-ink-800 disabled:opacity-40"
          >
            全选{query ? '筛选结果' : '全部'}
          </button>
          <button
            type="button"
            onClick={clearVisible}
            disabled={visible.length === 0}
            className="rounded px-2 py-1 text-[11px] text-ink-400 transition-colors hover:bg-ink-800 disabled:opacity-40"
          >
            取消选择
          </button>
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto p-1.5">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-ink-400">
            <OrbitSpinner size={16} />
            正在拉取模型列表…
          </div>
        ) : visible.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-600">
            {models.length === 0 ? '没有取到任何模型' : '没有匹配的模型'}
          </p>
        ) : (
          visible.map((m) => {
            const checked = selected.has(m.id);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => toggle(m.id)}
                className={[
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors',
                  checked ? 'bg-ink-800' : 'hover:bg-ink-850',
                ].join(' ')}
              >
                <span
                  className={[
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                    checked
                      ? 'border-brand-500 bg-brand-500 text-on-accent'
                      : 'border-ink-600',
                  ].join(' ')}
                >
                  {checked ? <Check size={11} strokeWidth={3} /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink-200">{m.id}</span>
                  {m.ownedBy ? (
                    <span className="block truncate text-[10px] text-ink-600">
                      {m.ownedBy}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
