/**
 * 历史记录面板。
 *
 * 对应需求：「历史生成记录，支持回滚、删除（全选/多选）」。
 *
 * 两处刻意的设计：
 *
 *  1. **回滚时让用户选"完全恢复"还是"仅套用样式"**。
 *     用户改了正文之后，完全恢复会覆盖他的新内容 ——
 *     那是很严重的意外。默认高亮"仅套用样式"（更安全的那一侧）。
 *
 *  2. **每条记录直接渲染成缩略图**，而不是存一张截图。
 *     渲染层是纯函数，所以这里用同一份 renderDocument 缩小画出来即可。
 *     好处是缩略图永远与真实版式一致，且不占存储。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  History as HistoryIcon,
  RotateCcw,
  Trash2,
  TriangleAlert,
  Check,
} from 'lucide-react';
import { useHistoryStore, contentMatches, type RollbackMode } from '@/core/history/store';
import type { HistoryEntry } from '@/core/history/api';
import { useWorkbenchStore } from '@/core/store/workbench';
import type { DocType } from '@/core/store/workbench';
import { renderDocument } from '@/core/render/render';
import { PROTOCOL_LABELS, type Protocol } from '@/core/llm/types';
import { RelativeTime } from '@/components/effects';

const DOC_LABELS: Record<DocType, string> = {
  resume: '简历',
  'cover-letter': '求职信',
};

/** 缩略图宽度（px）。A4 等比缩小。 */
const THUMB_WIDTH = 96;

export function HistoryPanel() {
  const entries = useHistoryStore((s) => s.entries);
  const loading = useHistoryStore((s) => s.loading);
  const error = useHistoryStore((s) => s.error);
  const selected = useHistoryStore((s) => s.selected);
  const load = useHistoryStore((s) => s.load);
  const toggleSelect = useHistoryStore((s) => s.toggleSelect);
  const selectAll = useHistoryStore((s) => s.selectAll);
  const clearSelection = useHistoryStore((s) => s.clearSelection);
  const clearError = useHistoryStore((s) => s.clearError);

  const [rollbackTarget, setRollbackTarget] = useState<HistoryEntry | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [filter, setFilter] = useState<'all' | DocType>('all');

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => (filter === 'all' ? entries : entries.filter((e) => e.docType === filter)),
    [entries, filter],
  );

  const allSelected = visible.length > 0 && visible.every((e) => selected.has(e.id));

  const doDelete = async (ids: string[]) => {
    setConfirmDelete(null);
    try {
      await useHistoryStore.getState().removeMany(ids);
    } catch {
      /* 错误已进 store */
    }
  };

  const doClear = async () => {
    setConfirmClear(false);
    try {
      await useHistoryStore.getState().clearAll();
    } catch {
      /* 错误已进 store */
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-ink-200">历史生成记录</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-400">
            每条记录保存完整的内容快照与设计参数，因此可以精确回滚。
          </p>
        </div>
        {entries.length > 0 ? (
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            className="shrink-0 rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-400 transition-colors hover:bg-ink-800 hover:text-rose-500"
          >
            清空全部
          </button>
        ) : null}
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
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-700 p-10 text-center">
          <HistoryIcon size={22} className="mx-auto text-ink-600" />
          <p className="hint-pulse mt-3 text-sm text-ink-400">还没有生成记录</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-600">
            在「简历美化」或「求职信美化」里生成版式后，记录会出现在这里。
          </p>
        </div>
      ) : (
        <>
          {/* ── 工具栏 ── */}
          <div className="mb-3 flex flex-wrap items-center gap-3 px-1">
            <div className="flex overflow-hidden rounded-md border border-ink-700">
              {(
                [
                  ['all', '全部'],
                  ['resume', '简历'],
                  ['cover-letter', '求职信'],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setFilter(v)}
                  className={[
                    'px-2.5 py-1 text-[11px] transition-colors',
                    filter === v
                      ? 'bg-ink-700 text-ink-200'
                      : 'text-ink-400 hover:bg-ink-800 hover:text-ink-300',
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-400">
              <input
                type="checkbox"
                className="accent-brand-500"
                checked={allSelected}
                onChange={(e) =>
                  e.target.checked
                    ? selectAll(visible.map((x) => x.id))
                    : clearSelection()
                }
              />
              全选（{visible.length} 条）
            </label>

            {selected.size > 0 ? (
              <>
                <span className="text-xs text-ink-600">已选 {selected.size} 条</span>
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

          {/* ── 列表 ── */}
          <ul className="space-y-2">
            {visible.map((entry, i) => (
              <HistoryRow
                key={entry.id}
                // 封顶 12：超过之后不再累加延迟，否则长列表末项要等很久
                index={Math.min(i, 12)}
                entry={entry}
                checked={selected.has(entry.id)}
                onToggle={() => toggleSelect(entry.id)}
                onRollback={() => setRollbackTarget(entry)}
                onDelete={() => setConfirmDelete([entry.id])}
              />
            ))}
          </ul>
        </>
      )}

      {/* ── 回滚对话框 ── */}
      {rollbackTarget ? (
        <RollbackDialog
          entry={rollbackTarget}
          onCancel={() => setRollbackTarget(null)}
          onConfirm={async (mode) => {
            const target = rollbackTarget;
            setRollbackTarget(null);
            await useHistoryStore.getState().rollback(target.id, mode);
          }}
        />
      ) : null}

      {/* ── 删除确认 ── */}
      {confirmDelete ? (
        <ConfirmDialog
          title={`确认删除 ${confirmDelete.length} 条记录？`}
          body="记录里保存的内容快照与设计参数都会被删除，此操作不可撤销。"
          confirmLabel="删除"
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void doDelete(confirmDelete)}
        />
      ) : null}

      {confirmClear ? (
        <ConfirmDialog
          title={`确认清空全部 ${entries.length} 条记录？`}
          body="所有内容快照与设计参数都会被删除，此操作不可撤销。"
          confirmLabel="清空"
          danger
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => void doClear()}
        />
      ) : null}
    </div>
  );
}

// ─────────────────────────── 单条记录 ───────────────────────────

function HistoryRow({
  entry,
  index = 0,
  checked,
  onToggle,
  onRollback,
  onDelete,
}: {
  entry: HistoryEntry;
  /** 入场动画的错开序号。已由调用方封顶到 12，避免长列表末项等太久。 */
  index?: number;
  checked: boolean;
  onToggle: () => void;
  onRollback: () => void;
  onDelete: () => void;
}) {
  // 当前编辑器里该板块的内容指纹，用于判断"是否已改动"
  const currentHash = useWorkbenchStore((s) => s.parsed[entry.docType]?.contentHash);
  const unchanged = contentMatches(entry, currentHash);

  const protocolLabel =
    PROTOCOL_LABELS[entry.protocol as Protocol] ?? String(entry.protocol);

  return (
    <li
      // stagger-item 用 --i 计算 animation-delay；card-lift 提供 hover 抬起
      style={{ '--i': index } as React.CSSProperties}
      className="card-lift stagger-item flex items-start gap-3 rounded-lg border border-ink-800 bg-ink-900 p-3 hover:border-ink-700"
    >
      <input
        type="checkbox"
        className="mt-1 accent-brand-500"
        checked={checked}
        onChange={onToggle}
        aria-label="选择该记录"
      />

      <Thumbnail entry={entry} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink-200">
            {DOC_LABELS[entry.docType]}
          </span>
          <span className="rounded border border-ink-700 px-1.5 py-0.5 text-[10px] text-ink-400">
            {entry.providerName} / {entry.modelName}
          </span>
          <span className="rounded border border-ink-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-600">
            {protocolLabel}
          </span>
          <span className="text-[11px] text-ink-600">
            <RelativeTime at={entry.createdAt} />
          </span>
        </div>

        <p className="mt-1.5 text-[11px] text-ink-600">
          {entry.contentSnapshot.length} 个内容单元 · 指纹{' '}
          {entry.contentHash.slice(0, 8)}
        </p>

        {/* 正文已改动时明确提示 —— 完全恢复会覆盖当前内容 */}
        {!unchanged ? (
          <p className="mt-1.5 flex items-center gap-1 text-[11px] text-warn-400">
            <TriangleAlert size={11} />
            当前正文与这条记录不同
          </p>
        ) : (
          <p className="mt-1.5 flex items-center gap-1 text-[11px] text-teal-500">
            <Check size={11} />
            与当前正文一致
          </p>
        )}

        {entry.note ? (
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-400">{entry.note}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col gap-1">
        <button
          type="button"
          onClick={onRollback}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[11px] text-ink-300 transition-colors hover:bg-ink-800"
        >
          <RotateCcw size={12} />
          回滚
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] text-ink-600 transition-colors hover:bg-ink-800 hover:text-rose-500"
        >
          <Trash2 size={12} />
          删除
        </button>
      </div>
    </li>
  );
}

/**
 * 缩略图。
 *
 * 不存截图，而是用同一份渲染函数现场画一个缩小版 ——
 * 这样缩略图永远与真实版式一致，也不占存储。
 */
function Thumbnail({ entry }: { entry: HistoryEntry }) {
  const html = useMemo(() => {
    try {
      return renderDocument(entry.contentSnapshot, entry.designSpec, {
        includeStyle: true,
      });
    } catch {
      // 历史数据可能来自旧版本，渲染失败时退化成一个占位块，
      // 而不是让整个列表崩掉
      return '';
    }
  }, [entry]);

  const scale = THUMB_WIDTH / 794;

  if (!html) {
    return (
      <div
        className="shrink-0 rounded border border-ink-700 bg-ink-800"
        style={{ width: THUMB_WIDTH, height: THUMB_WIDTH * 1.414 }}
      />
    );
  }

  return (
    <div
      className="shrink-0 overflow-hidden rounded border border-ink-700 bg-white"
      style={{ width: THUMB_WIDTH, height: THUMB_WIDTH * 1.414 }}
      aria-hidden="true"
    >
      <div
        style={{
          width: 794,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          pointerEvents: 'none',
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

// ─────────────────────────── 对话框 ───────────────────────────

/**
 * 回滚方式选择。
 *
 * 默认高亮「仅套用样式」——那是更安全的一侧：
 * 最坏情况只是版式没换成功，而正文不会丢。
 */
function RollbackDialog({
  entry,
  onCancel,
  onConfirm,
}: {
  entry: HistoryEntry;
  onCancel: () => void;
  onConfirm: (mode: RollbackMode) => void;
}) {
  const currentHash = useWorkbenchStore((s) => s.parsed[entry.docType]?.contentHash);
  const unchanged = contentMatches(entry, currentHash);
  const [mode, setMode] = useState<RollbackMode>('style-only');

  const options: Array<{ value: RollbackMode; label: string; desc: string }> = [
    {
      value: 'style-only',
      label: '仅套用样式',
      desc: '保留你正在编辑的正文，只把版式换成这条记录的。适合"又加了内容，想沿用上次的版式"。',
    },
    {
      value: 'full',
      label: '完全恢复',
      desc: unchanged
        ? '正文与这条记录一致，恢复不会丢失任何改动。'
        : '⚠ 会用这条记录里的正文覆盖你当前的正文，当前未保存的改动将丢失。',
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-xl border border-ink-700 bg-ink-900 p-5">
        <h3 className="text-sm font-semibold text-ink-200">回滚这条记录</h3>
        <p className="mt-2 text-xs leading-relaxed text-ink-400">
          {DOC_LABELS[entry.docType]} · {entry.providerName} / {entry.modelName} ·{' '}
          <RelativeTime at={entry.createdAt} />
        </p>

        <div className="mt-4 space-y-2">
          {options.map((o) => {
            const active = mode === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => setMode(o.value)}
                className={[
                  'flex w-full items-start gap-2.5 rounded-lg border p-3 text-left transition-colors',
                  active ? 'border-brand-500 bg-brand-500/10' : 'border-ink-700 hover:border-ink-600',
                ].join(' ')}
              >
                <span
                  className={[
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                    active ? 'border-brand-500' : 'border-ink-600',
                  ].join(' ')}
                  aria-hidden="true"
                >
                  {active ? <span className="h-2 w-2 rounded-full bg-brand-500" /> : null}
                </span>
                <span className="min-w-0">
                  <span
                    className={[
                      'block text-sm font-medium',
                      active ? 'text-brand-400' : 'text-ink-200',
                    ].join(' ')}
                  >
                    {o.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-400">
                    {o.desc}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3.5 py-2 text-sm text-ink-300 transition-colors hover:bg-ink-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onConfirm(mode)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3.5 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-brand-400"
          >
            <RotateCcw size={13} />
            回滚
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-sm rounded-xl border border-ink-700 bg-ink-900 p-5">
        <h3 className="text-sm font-semibold text-ink-200">{title}</h3>
        <p className="mt-2 text-xs leading-relaxed text-ink-400">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3.5 py-2 text-sm text-ink-300 transition-colors hover:bg-ink-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={[
              'rounded-lg px-3.5 py-2 text-sm font-semibold transition-opacity hover:opacity-90',
              danger ? 'bg-danger-500 text-white' : 'bg-brand-500 text-on-accent',
            ].join(' ')}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
