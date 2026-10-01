/**
 * 供应商编排：列表 + 编辑表单。
 */

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useProviderStore } from '@/core/llm/store';
import type { Provider } from '@/core/llm/types';
import { ProviderForm } from './ProviderForm';
import { RelativeTime } from '@/components/effects';

/** 一个尚未保存的空供应商。 */
function blankProvider(): Provider {
  return {
    id: `p_${Math.random().toString(36).slice(2, 18)}`,
    name: '',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'chat_completions',
    secretRef: '',
    models: [],
  };
}

export function ProviderSettings() {
  const providers = useProviderStore((s) => s.providers);
  const loading = useProviderStore((s) => s.loading);
  const error = useProviderStore((s) => s.error);
  const clearError = useProviderStore((s) => s.clearError);
  const remove = useProviderStore((s) => s.remove);

  /** null = 未在编辑；否则是被编辑的对象（可能是新对象）。 */
  const [editing, setEditing] = useState<Provider | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const allSelected = providers.length > 0 && selected.size === providers.length;

  const confirmAndDelete = async (ids: string[]) => {
    setConfirmDelete(null);
    try {
      if (ids.length === 1) await remove(ids[0]!);
      else await useProviderStore.getState().removeMany(ids);
      setSelected(new Set());
    } catch {
      // 错误已写入 store，这里无需重复处理
    }
  };

  if (editing) {
    return (
      <ProviderForm
        initial={editing}
        onDone={() => setEditing(null)}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-ink-200">模型供应商</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-400">
            自备 Base URL 与 API Key。密钥保存在系统凭据管理器中，不写入配置文件。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing(blankProvider())}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-500 px-3.5 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-brand-400"
        >
          <Plus size={15} />
          添加供应商
        </button>
      </header>

      {error ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3">
          <p className="min-w-0 flex-1 whitespace-pre-wrap text-xs leading-relaxed text-rose-500">
            {error}
          </p>
          <button
            type="button"
            onClick={clearError}
            className="shrink-0 text-xs text-rose-500/70 hover:text-rose-500"
          >
            关闭
          </button>
        </div>
      ) : null}

      {loading ? (
        <p className="py-10 text-center text-sm text-ink-400">加载中…</p>
      ) : providers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-700 p-10 text-center">
          <p className="hint-pulse text-sm text-ink-400">尚未添加任何供应商</p>
          <p className="mt-1.5 text-xs text-ink-600">
            添加后可一键拉取该端点支持的模型列表
          </p>
        </div>
      ) : (
        <>
          <div className="mb-2.5 flex items-center gap-3 px-1">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-400">
              <input
                type="checkbox"
                className="accent-brand-500"
                checked={allSelected}
                onChange={(e) => {
                  setSelected(e.target.checked ? new Set(providers.map((p) => p.id)) : new Set());
                }}
              />
              全选
            </label>
            {selected.size > 0 ? (
              <>
                <span className="text-xs text-ink-600">已选 {selected.size} 个</span>
                <button
                  type="button"
                  onClick={() => setConfirmDelete([...selected])}
                  className="ml-auto inline-flex items-center gap-1 text-xs text-rose-500 transition-opacity hover:opacity-80"
                >
                  <Trash2 size={12} />
                  删除选中
                </button>
              </>
            ) : null}
          </div>

          <ul className="space-y-2">
            {providers.map((p, i) => (
              <li
                key={p.id}
                style={{ '--i': Math.min(i, 12) } as React.CSSProperties}
                className="card-lift stagger-item flex items-center gap-3 rounded-lg border border-ink-800 bg-ink-900 p-3.5 hover:border-ink-700"
              >
                <input
                  type="checkbox"
                  className="accent-brand-500"
                  checked={selected.has(p.id)}
                  onChange={() => toggleSelect(p.id)}
                  aria-label={`选择 ${p.name}`}
                />

                <button
                  type="button"
                  onClick={() => setEditing(p)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink-200">
                      {p.name || '(未命名)'}
                    </span>
                    <span className="shrink-0 rounded border border-ink-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-400">
                      {p.protocol === 'responses' ? 'Responses' : 'Chat Completions'}
                    </span>
                    {p.lastProbe ? (
                      <span
                        className={[
                          'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                          p.lastProbe.ok
                            ? 'bg-teal-500/15 text-teal-500'
                            : 'bg-rose-500/15 text-rose-500',
                        ].join(' ')}
                      >
                        {p.lastProbe.ok
                          ? `连通 ${p.lastProbe.latencyMs ?? '?'}ms`
                          : '不通'}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-600">
                    <span className="truncate font-mono">{p.baseUrl}</span>
                    <span className="shrink-0">·</span>
                    <span className="shrink-0">{p.models.length} 个模型</span>
                    {p.lastProbe ? (
                      <>
                        <span className="shrink-0">·</span>
                        <span className="shrink-0">
                          <RelativeTime at={p.lastProbe.at} />
                        </span>
                      </>
                    ) : null}
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setConfirmDelete([p.id])}
                  className="shrink-0 rounded-md p-2 text-ink-600 transition-colors hover:bg-ink-800 hover:text-rose-500"
                  aria-label={`删除 ${p.name}`}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {confirmDelete ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm rounded-xl border border-ink-700 bg-ink-900 p-5">
            <h3 className="text-sm font-semibold text-ink-200">
              确认删除 {confirmDelete.length} 个供应商？
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-ink-400">
              其配置与系统凭据管理器中的 API Key 都会被一并删除，此操作不可撤销。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                className="rounded-lg px-3.5 py-2 text-sm text-ink-300 transition-colors hover:bg-ink-800"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmAndDelete(confirmDelete)}
                className="rounded-lg bg-danger-500 px-3.5 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
