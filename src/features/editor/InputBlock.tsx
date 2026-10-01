/**
 * 共享的输入区外壳。
 *
 * 方块 1–5 外观一致：编号徽标 + 标题 + 说明 + 内容。
 * 抽成一个组件，避免五处各写一遍导致视觉漂移。
 */

import type { ReactNode } from 'react';

export function InputBlock({
  index,
  title,
  hint,
  badge,
  children,
}: {
  /** 方块编号 1–5。 */
  index: number;
  title: string;
  hint: string;
  /** 右上角的状态徽标（如"已解析 23 个单元"）。 */
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900 p-4">
      <header className="mb-3 flex items-start gap-3">
        <span
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-ink-700 text-[11px] font-semibold text-ink-400"
          aria-hidden="true"
        >
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-ink-200">{title}</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-600">{hint}</p>
        </div>
        {badge ? <div className="shrink-0">{badge}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** 纯文本 / Markdown 模式切换。 */
export function ModeSwitch({
  mode,
  onChange,
}: {
  mode: 'plain' | 'markdown';
  onChange: (m: 'plain' | 'markdown') => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="输入格式"
      className="inline-flex overflow-hidden rounded-md border border-ink-700"
    >
      {(
        [
          ['plain', '纯文本'],
          ['markdown', 'Markdown'],
        ] as const
      ).map(([value, label]) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(value)}
            className={[
              'px-2 py-0.5 text-[11px] transition-colors',
              active
                ? 'bg-ink-700 text-ink-200'
                : 'text-ink-400 hover:bg-ink-800 hover:text-ink-300',
            ].join(' ')}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
