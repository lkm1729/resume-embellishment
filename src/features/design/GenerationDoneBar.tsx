/**
 * 「生成完成」提示条。
 *
 * 同一份信息要出现在两个地方：预览板顶部（看结果时）和生成按钮下方
 * （点完按钮、视线还没离开按钮时）。抽成一个组件而不是复制两遍，
 * 是因为这两处一旦漂移，用户会看到两个互相矛盾的"这次用了什么模型"，
 * 而那种矛盾比缺一条提示更让人不信任。
 *
 * 两种外形：
 *   - `attached`：贴着预览板顶部的通栏行（自带下边框，和工具条连成一体）
 *   - `card`：输入区里的独立圆角块（生成按钮下方用这个）
 */

import { CheckCircle2, Info } from 'lucide-react';
import type { DocType } from '@/core/store/workbench';
import { useGenerationStore } from '@/core/store/generation';
import { PROTOCOL_LABELS } from '@/core/llm/types';

/**
 * 绝对时间，不用"3 分钟前"。
 *
 * 这条提示会跟着导出的文件被回头查看（"这是哪次生成的？"），
 * 相对时间隔天再看就完全没用了。秒刻意不显示 —— 精确到分钟已经
 * 足够回答"哪一次"，多两位数字只会让人多看两眼。
 */
export function formatWhen(at: number): string {
  return new Date(at).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function GenerationDoneBar({
  type,
  variant = 'card',
}: {
  type: DocType;
  /** `attached` 通栏（预览板顶部）；`card` 圆角块（输入区）。 */
  variant?: 'card' | 'attached';
}) {
  const run = useGenerationStore((s) => s.run[type]);
  // 选择器返回 number，结果稳定，不会让整块无谓重渲染
  const applied = useGenerationStore((s) => s.refinements[type].filter((r) => r.ok).length);

  const attached = variant === 'attached';
  const frame = attached
    ? `flex items-center gap-2 border-b border-ink-800 px-3 py-1.5${run ? ' bg-teal-500/5' : ''}`
    : `flex items-center gap-2 rounded-lg border px-2.5 py-2 ${
        run ? 'border-teal-500/30 bg-teal-500/5' : 'border-ink-800'
      }`;

  /*
    ⚠ 调整过之后 `run.at` 仍然是**最初那次生成**的时间
    （「继续调整」沿用同一个供应商/模型，不会刷新 run）。
    所以这里额外标出调整轮数 —— 否则用户会以为屏幕上这一版
    就是那个时间点生成的。
  */
  return (
    <div className={frame}>
      {run ? (
        <>
          <CheckCircle2 size={13} className="shrink-0 text-teal-500" aria-hidden="true" />
          <span className="shrink-0 text-[11px] font-medium text-teal-500">生成完成</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-500">
            {run.providerName} / {run.modelName} · {PROTOCOL_LABELS[run.protocol]} ·{' '}
            <time
              dateTime={new Date(run.at).toISOString()}
              className="tabular-nums"
              title="这次生成的时间"
            >
              {formatWhen(run.at)}
            </time>
          </span>
          {applied > 0 ? (
            <span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400">
              已调整 {applied} 轮
            </span>
          ) : null}
        </>
      ) : (
        <>
          <Info size={13} className="shrink-0 text-ink-600" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-[11px] text-ink-600">
            这份版式是本地兜底预览，没有用到模型，也就没有供应商信息。
          </span>
        </>
      )}
    </div>
  );
}
