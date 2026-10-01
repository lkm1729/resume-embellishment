/**
 * 视觉效果组件。
 *
 * 对应需求里的：
 *   视觉效果2 —— "简历生成中" / "求职信生成中"渐变文字 + 动态加载图标
 *   视觉效果3 —— 生成板块的指向性材质（渐变描边、spotlight、噪点）
 *
 * 全部用 CSS 实现，不引入动画库（framer-motion 等）——
 * 这几处效果用原生 CSS 表达更轻，且能自动尊重 prefers-reduced-motion。
 */

import type { ReactNode, CSSProperties, MouseEvent } from 'react';

/** 带动画圆环的加载图标。比 animate-spin 更有"进程"感。 */
export function OrbitSpinner({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 50 50"
      role="status"
      aria-label="加载中"
      className="shrink-0"
    >
      <circle
        cx="25"
        cy="25"
        r="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        opacity="0.18"
      />
      <circle
        cx="25"
        cy="25"
        r="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        className="orbit-ring"
      />
    </svg>
  );
}

/**
 * 渐变流动文字。
 *
 * 动效本身在 CSS 里（`.gradient-text`），
 * 这里只负责语义与无障碍：用 `role="status"` 让屏幕阅读器播报状态变化。
 */
export function GradientText({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span role="status" className={`gradient-text font-semibold ${className}`}>
      {children}
    </span>
  );
}

/**
 * 生成中提示：渐变文字 + 圆环 + 可选进度说明。
 *
 * @param label   "简历生成中" / "求职信生成中"
 * @param detail  当前阶段的补充说明（如"正在解析内容"）
 */
export function GeneratingBadge({
  label,
  detail,
}: {
  label: string;
  detail?: string;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-900/80 px-4 py-3"
      data-testid="generating-badge"
    >
      <span className="text-brand-400">
        <OrbitSpinner size={20} />
      </span>
      <div className="min-w-0">
        <GradientText className="text-base">{label}</GradientText>
        {detail ? (
          <p className="mt-0.5 truncate text-xs text-ink-400">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 生成按钮。
 *
 * 平时有呼吸光晕（暗示可点击），生成中变为禁用并显示状态文字。
 */
export function GenerateButton({
  label,
  generatingLabel,
  generating,
  onClick,
  disabled,
}: {
  label: string;
  generatingLabel: string;
  generating: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  const isDisabled = generating || disabled;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      className={[
        'relative inline-flex items-center gap-2 rounded-lg px-5 py-2.5',
        'text-sm font-semibold transition-all duration-200',
        isDisabled
          ? 'cursor-not-allowed bg-ink-800 text-ink-400'
          : 'idle-breathe bg-brand-500 text-on-accent hover:bg-brand-400 active:scale-[0.98]',
      ].join(' ')}
    >
      {generating ? (
        <>
          <OrbitSpinner size={16} />
          <span>{generatingLabel}</span>
        </>
      ) : (
        <span>{label}</span>
      )}
    </button>
  );
}

/**
 * 指向性容器：渐变描边 + 跟随鼠标的 spotlight + 噪点材质。
 *
 * 用途：包住"AI 生成"区域，让用户一眼能找到它。
 * spotlight 的坐标写进 CSS 变量 `--mx/--my`，由 CSS 的 radial-gradient 消费。
 */
export function AuraPanel({
  children,
  className = '',
  active = false,
}: {
  children: ReactNode;
  className?: string;
  /** 生成中时置 true，让描边旋转起来。 */
  active?: boolean;
}) {
  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    el.style.setProperty('--mx', `${x}%`);
    el.style.setProperty('--my', `${y}%`);
  };

  return (
    <div
      onMouseMove={onMove}
      data-active={active}
      className={[
        'aura-border spotlight noise relative rounded-xl',
        'bg-ink-850',
        className,
      ].join(' ')}
    >
      {children}
    </div>
  );
}

/**
 * 模型信息标签。
 *
 * 对应视觉效果1：生成按钮旁边显示供应商 / 模型名称（协议）/ 生成时间。
 */
export function ModelChip({
  providerName,
  modelName,
  protocolLabel,
  generatedAt,
  className = '',
}: {
  providerName: string;
  modelName: string;
  protocolLabel: string;
  /** 毫秒时间戳；缺省时只显示模型信息。 */
  generatedAt?: number;
  className?: string;
}) {
  const style: CSSProperties = {};

  return (
    <div
      className={[
        'inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-400',
        className,
      ].join(' ')}
      style={style}
      title={
        generatedAt
          ? `生成于 ${new Date(generatedAt).toLocaleString('zh-CN')}`
          : undefined
      }
    >
      <span className="rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-ink-300">
        {providerName}
      </span>
      <span className="text-ink-600">/</span>
      <span className="font-medium text-ink-200">{modelName}</span>
      <span className="rounded border border-ink-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-400">
        {protocolLabel}
      </span>
      {generatedAt ? (
        <>
          <span className="text-ink-600">·</span>
          <RelativeTime at={generatedAt} />
        </>
      ) : null}
    </div>
  );
}

/**
 * 相对时间。
 *
 * 用 <time> 元素并带绝对时间的 title —— 相对时间好读，
 * 但用户需要精确时间时（比如对比两次生成）能立刻拿到。
 */
export function RelativeTime({ at }: { at: number }) {
  const diff = Date.now() - at;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  let label: string;
  if (diff < 60000) label = '刚刚';
  else if (mins < 60) label = `${mins} 分钟前`;
  else if (hours < 24) label = `${hours} 小时前`;
  else if (days < 30) label = `${days} 天前`;
  else label = new Date(at).toLocaleDateString('zh-CN');

  return (
    <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString('zh-CN')}>
      {label}
    </time>
  );
}
