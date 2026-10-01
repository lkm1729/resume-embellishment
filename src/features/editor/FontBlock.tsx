/**
 * 自定义字体（V0.1.2 第 2 条）。
 *
 * 选项来自**这台电脑上真实装了的字体族**，不是一份写死的清单 ——
 * 用户说的是"用我电脑里那个字体"。后端走 GDI 枚举（`src-tauri/src/fonts.rs`），
 * 拿到的才是族名；注册表那份混着一半 `Arial Bold` 这样的全名，
 * 选中会静默回退成默认字体，等于选了个寂寞。
 *
 * 选择结果**不写进 spec**，而是一层渲染/导出前的覆盖 ——
 * 理由见 `core/fonts/effective.ts` 与 `core/design/spec.ts` 的注释。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, RotateCcw } from 'lucide-react';
import type { DocType } from '@/core/store/workbench';
import { useGenerationStore } from '@/core/store/generation';
import {
  filterFonts,
  loadFontCatalog,
  resetFontCatalog,
  type FontCatalog,
  type FontOption,
} from '@/core/fonts/system';
import { InputBlock } from './InputBlock';

export function FontBlock({ type }: { type: DocType }) {
  const spec = useGenerationStore((s) => s.spec[type]);
  const override = useGenerationStore((s) => s.fontOverride[type]);
  const setFontOverride = useGenerationStore((s) => s.setFontOverride);

  const [catalog, setCatalog] = useState<FontCatalog | null>(null);
  // 重试计数。`loadFontCatalog` 会永久缓存结果（**包括失败**），
  // 没有这个计数器，「重新读取」按多少次都只会拿到同一份失败结果。
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    void loadFontCatalog().then((next) => {
      if (alive) setCatalog(next);
    });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = () => {
    resetFontCatalog();
    // 先回到"正在读取…"，否则按钮按下去界面毫无变化，像是没生效。
    setCatalog(null);
    setAttempt((n) => n + 1);
  };

  // value → 选项，用来把存下来的字体名翻回给人看的名字。
  const byValue = useMemo(() => {
    const map = new Map<string, FontOption>();
    for (const option of [...(catalog?.recommended ?? []), ...(catalog?.others ?? [])]) {
      map.set(option.value, option);
    }
    return map;
  }, [catalog]);

  const overridden = override.heading !== null || override.body !== null;

  return (
    <InputBlock
      index={7}
      title="字体"
      hint="指定标题和正文用哪款字体。留空则跟随版式 —— 模型挑的那对。这里只会换字体，不动字号和配色。"
      badge={
        <span className="text-[11px] text-ink-600">{overridden ? '已指定' : '跟随版式'}</span>
      }
    >
      {catalog === null ? (
        <p className="text-[11px] text-ink-600">正在读取这台电脑的字体…</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <FontPicker
              label="标题字体"
              value={override.heading}
              fallback={spec ? spec.theme.fontPair.heading : null}
              catalog={catalog}
              byValue={byValue}
              onChange={(next) => setFontOverride(type, { ...override, heading: next })}
            />
            <FontPicker
              label="正文字体"
              value={override.body}
              fallback={spec ? spec.theme.fontPair.body : null}
              catalog={catalog}
              byValue={byValue}
              onChange={(next) => setFontOverride(type, { ...override, body: next })}
            />
          </div>

          {!catalog.fromSystem ? (
            <div className="mt-2 rounded-lg border border-ink-800 bg-ink-950/50 p-2.5 text-[11px] leading-relaxed text-ink-600">
              没能读到这台电脑的字体列表，下面只列出内置的
              {catalog.recommended.length} 个。这不代表你没装别的字体。
              {catalog.error ? (
                <span className="mt-1 block text-ink-700">读取失败：{catalog.error}</span>
              ) : null}
              {/*
                读取结果（**包括失败**）是永久缓存的，所以一次失败会让这个面板
                到重启为止都只有 19 个内置字体。给一个出口，而不是让用户
                以为"我的电脑上就这么几个字体"。
              */}
              <button
                type="button"
                onClick={retry}
                className="mt-1.5 flex items-center gap-1 text-[10px] text-ink-600 transition-colors hover:text-ink-400"
              >
                <RotateCcw size={10} />
                重新读取
              </button>
            </div>
          ) : null}
        </>
      )}
    </InputBlock>
  );
}

function FontPicker({
  label,
  value,
  fallback,
  catalog,
  byValue,
  onChange,
}: {
  label: string;
  /** 用户指定的字体；`null` = 跟随版式。 */
  value: string | null;
  /** 版式自带的那款，仅用于「跟随版式」这一项的说明。 */
  fallback: string | null;
  catalog: FontCatalog;
  byValue: Map<string, FontOption>;
  onChange: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;

    searchRef.current?.focus();

    // 点面板外面就收起。用 pointerdown 而不是 click：
    // click 要等按下并抬起，用户拖一下就关不掉了。
    const onPointerDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // 收起时清掉搜索词：下次打开是完整一屏，
  // 而不是上次那个把列表筛成两行的旧关键词。
  useEffect(() => {
    if (!open) setKeyword('');
  }, [open]);

  const recommended = filterFonts(catalog.recommended, keyword);
  const others = filterFonts(catalog.others, keyword);
  const empty = recommended.length === 0 && others.length === 0;

  const display = value === null ? '跟随版式' : (byValue.get(value)?.label ?? value);

  return (
    <div className="min-w-0">
      <label className="mb-1.5 block text-xs font-medium text-ink-300">{label}</label>

      <div ref={boxRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="field flex w-full items-center justify-between gap-2 text-left"
        >
          <span
            className={[
              'min-w-0 truncate text-[13px]',
              value === null ? 'text-ink-500' : 'text-ink-200',
            ].join(' ')}
            // 用该字体本身显示名字 —— 选之前就能看出长什么样。
            // 字体缺失时浏览器会回退，不会报错，所以这里不需要守卫。
            style={value === null ? undefined : { fontFamily: `"${value}"` }}
          >
            {display}
          </span>
          <ChevronDown size={13} className="shrink-0 text-ink-600" />
        </button>

        {open ? (
          <div className="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-lg border border-ink-700 bg-ink-900 shadow-2xl">
            <div className="border-b border-ink-800 p-2">
              <input
                ref={searchRef}
                className="field text-xs"
                aria-label={`搜索${label}`}
                placeholder="搜索字体名（中文、英文都可以）"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
            </div>

            <div className="max-h-64 overflow-y-auto p-1">
              {keyword.trim().length === 0 ? (
                <PickerItem
                  label="跟随版式"
                  sub={fallback ? `当前：${fallback}` : '由模型决定'}
                  active={value === null}
                  muted
                  onPick={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                />
              ) : null}

              {recommended.length > 0 ? (
                <PickerGroup title="内置推荐" count={recommended.length} />
              ) : null}
              {recommended.map((option) => (
                <PickerItem
                  key={`r-${option.value}`}
                  label={option.label}
                  sub={option.label === option.value ? null : option.value}
                  active={option.value === value}
                  fontFamily={option.value}
                  onPick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                />
              ))}

              {others.length > 0 ? (
                <PickerGroup title="这台电脑上的其他字体" count={others.length} />
              ) : null}
              {others.map((option) => (
                <PickerItem
                  key={`o-${option.value}`}
                  label={option.label}
                  sub={null}
                  active={option.value === value}
                  fontFamily={option.value}
                  onPick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                />
              ))}

              {empty ? (
                <p className="px-2 py-4 text-center text-[11px] text-ink-600">
                  没有匹配的字体。
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {value !== null ? (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="mt-1.5 flex items-center gap-1 text-[10px] text-ink-600 transition-colors hover:text-ink-400"
        >
          <RotateCcw size={10} />
          改回跟随版式
        </button>
      ) : null}
    </div>
  );
}

function PickerGroup({ title, count }: { title: string; count: number }) {
  return (
    <p className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-ink-600">
      {title}
      <span className="ml-1 font-normal normal-case tracking-normal">（{count}）</span>
    </p>
  );
}

function PickerItem({
  label,
  sub,
  active,
  muted = false,
  fontFamily,
  onPick,
}: {
  label: string;
  sub: string | null;
  active: boolean;
  muted?: boolean;
  fontFamily?: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      // 刻意**不**用 `role="option"` / `aria-selected`。这套东西属于 listbox，
      // 而真正的 listbox 要能用上下键走、要有 `aria-activedescendant` ——
      // 这里只有 Tab 和鼠标。挂上半套 ARIA 比不挂更糟：读屏会按 listbox
      // 的规矩念，用户按上下键却发现没反应。它本来就是个按钮，就让它当按钮。
      aria-current={active ? 'true' : undefined}
      onClick={onPick}
      className={[
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors',
        active ? 'bg-brand-500/10' : 'hover:bg-ink-800',
      ].join(' ')}
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {active ? <Check size={11} className="text-brand-400" /> : null}
      </span>
      <span
        className={[
          'min-w-0 flex-1 truncate text-[12px]',
          muted ? 'text-ink-500' : 'text-ink-200',
        ].join(' ')}
        style={fontFamily ? { fontFamily: `"${fontFamily}"` } : undefined}
      >
        {label}
      </span>
      {sub ? (
        <span className="shrink-0 text-[10px] text-ink-600" title={sub}>
          {sub}
        </span>
      ) : null}
    </button>
  );
}
