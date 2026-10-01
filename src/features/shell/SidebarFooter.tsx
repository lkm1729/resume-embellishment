/**
 * 侧边栏底部状态条 + 「关于」面板。
 *
 * 两件事合在一起放，因为它们是同一类内容：低频、设置性质、
 * 不该占据高频可见位置。
 *
 * 左侧是版本号（需求：显示 `V0.1.0(20260928)`），
 * 右侧是主题开关（浅 / 深 / 跟随系统）。
 *
 * 「关于」面板不是可有可无的装饰：SIL OFL 1.1 要求每一份拷贝都带上
 * 版权声明与许可证原文，这个面板就是那个落点。
 * 移除它会让内嵌字体失去许可依据。
 */

import { useState } from 'react';
import { Monitor, Moon, Sun, Info, X, Scale } from 'lucide-react';
import {
  THEME_META,
  switchTheme,
  useThemeStore,
  type ThemePref,
} from '@/core/ui/theme';
import {
  VERSION_LABEL,
  APP_VERSION,
  prettyStamp,
  FONT_CREDITS,
} from '@/core/ui/version';

/** 三态图标。 */
const THEME_ICON: Record<ThemePref, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

export function SidebarFooter({ keyringError }: { keyringError: string | null }) {
  const pref = useThemeStore((s) => s.pref);
  const [aboutOpen, setAboutOpen] = useState(false);

  const Icon = THEME_ICON[pref];
  const meta = THEME_META[pref];

  return (
    <>
      {/* 密钥环错误浮在状态条之上 —— 它是需要立刻被看到的信息，
          不该被压在一个角落的状态条下面 */}
      {keyringError ? (
        <div className="mx-2 mb-1 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5">
          <p className="text-[11px] leading-relaxed text-rose-500">{keyringError}</p>
        </div>
      ) : null}

      <div className="flex items-center gap-1 border-t border-ink-800 px-3 py-2">
        {/* 版本号：可点，打开「关于」 */}
        <button
          type="button"
          onClick={() => setAboutOpen(true)}
          className="min-w-0 flex-1 truncate text-left text-[10px] tabular-nums text-ink-600 transition-colors hover:text-ink-400"
          title="查看版本与第三方许可"
        >
          {VERSION_LABEL}
        </button>

        {/* 主题开关：单击循环 浅→深→跟随系统 */}
        <button
          type="button"
          onClick={() => switchTheme(nextPref(pref))}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-ink-600 transition-colors hover:bg-ink-800 hover:text-ink-300"
          title={`外观：${meta.label}（${meta.hint}）—— 点击切换`}
          aria-label={`外观：${meta.label}，点击切换`}
        >
          <Icon size={12} />
          <span>{meta.label}</span>
        </button>
      </div>

      {aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} /> : null}
    </>
  );
}

/** 循环顺序。与 theme.ts 的 cycle() 保持一致。 */
function nextPref(cur: ThemePref): ThemePref {
  return cur === 'light' ? 'dark' : cur === 'dark' ? 'system' : 'light';
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      role="dialog"
      aria-modal="true"
      aria-label="关于"
      onClick={onClose}
    >
      <div
        className="pop-in w-full max-w-md rounded-xl border border-ink-700 bg-ink-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Info size={15} className="text-brand-400" />
            <h3 className="text-sm font-semibold text-ink-200">关于</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-600 transition-colors hover:bg-ink-800 hover:text-ink-300"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>

        <dl className="mt-4 space-y-2 text-xs">
          <Row label="版本" value={`V${APP_VERSION}`} mono />
          <Row label="构建日期" value={prettyStamp()} mono />
          <Row label="界面语言" value="简体中文" />
        </dl>

        <div className="mt-5 border-t border-ink-800 pt-4">
          <div className="flex items-center gap-1.5">
            <Scale size={13} className="text-ink-600" />
            <h4 className="text-xs font-medium text-ink-300">第三方字体</h4>
          </div>

          <ul className="mt-2.5 space-y-3">
            {FONT_CREDITS.map((f) => (
              <li key={f.name} className="text-[11px] leading-relaxed">
                <p className="text-ink-300">
                  <span className="font-medium text-ink-200">{f.name}</span>
                  <span className="text-ink-600"> · {f.holder}</span>
                </p>
                <p className="mt-0.5 text-ink-600">{f.license}</p>
                <p className="mt-0.5 text-ink-600">{f.note}</p>
                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 inline-block text-brand-400 hover:underline"
                >
                  {f.url}
                </a>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-[10px] leading-relaxed text-ink-600">
            字体文件已随应用一同分发，并按各自许可保留了版权声明与协议全文
            （见仓库根的 NOTICE 文件）。
          </p>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-on-accent transition-opacity hover:opacity-90"
          >
            好的
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-ink-600">{label}</dt>
      <dd className={`min-w-0 truncate text-ink-200 ${mono ? 'tabular-nums' : ''}`}>{value}</dd>
    </div>
  );
}
