/**
 * A4 预览板。
 *
 * ═══════════════════════════════════════════════════════════════
 *  这里渲染的 HTML 与导出时**完全相同**（同一个 `renderDocument` 调用）。
 *  预览、导出、历史回滚三处共用一份渲染结果，
 *  因此不会出现"预览好看、导出变样"这类问题。
 * ═══════════════════════════════════════════════════════════════
 *
 * 页数估算是有意做的：简历超过一页是个很实际的信号，
 * 用户往往直到打印才发现。与其等他导出后再后悔，不如实时告诉他。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, Maximize2, FileWarning } from 'lucide-react';
import type { ContentUnit } from '@/core/content/types';
import type { DesignSpec } from '@/core/design/spec';
import type { DocType } from '@/core/store/workbench';
import { A4_WIDTH_PX, A4_HEIGHT_PX, renderDocument } from '@/core/render/render';
import { GenerationDoneBar } from '@/features/design/GenerationDoneBar';
import { ExportButtons } from './ExportButtons';

const ZOOM_STEPS = [0.4, 0.5, 0.65, 0.8, 1.0, 1.25] as const;

export function PreviewPanel({
  units,
  spec,
  docLabel,
  docType,
}: {
  units: readonly ContentUnit[];
  spec: DesignSpec | null;
  docLabel: string;
  /** 文档类型：传给导出按钮，决定文件名主体与导出记录。 */
  docType: DocType;
}) {
  const [zoom, setZoom] = useState(0.65);
  const [pages, setPages] = useState(1);
  const contentRef = useRef<HTMLDivElement>(null);

  const html = useMemo(
    () => (spec ? renderDocument(units, spec) : ''),
    [units, spec],
  );

  // 量测渲染高度以估算页数。
  // 用 ResizeObserver 而不是在渲染后读一次 —— 字体加载完成、
  // 窗口变化都会改变高度，只读一次会得到过时的页数。
  useEffect(() => {
    const el = contentRef.current;
    if (!el || !spec) {
      setPages(1);
      return;
    }

    const measure = () => {
      const h = el.scrollHeight;
      setPages(Math.max(1, Math.ceil(h / A4_HEIGHT_PX)));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // 字体加载完成后高度会变，需要再量一次
    void document.fonts?.ready.then(measure).catch(() => {});

    return () => ro.disconnect();
  }, [html, spec]);

  const zoomIndex = ZOOM_STEPS.indexOf(zoom as (typeof ZOOM_STEPS)[number]);
  const canZoomIn = zoomIndex < ZOOM_STEPS.length - 1;
  const canZoomOut = zoomIndex > 0;

  const stepZoom = (dir: 1 | -1) => {
    const next = ZOOM_STEPS[zoomIndex + dir];
    if (next !== undefined) setZoom(next);
  };

  if (!spec) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-ink-700 p-8">
        <div className="max-w-sm text-center">
          <p className="hint-pulse text-sm text-ink-400">还没有生成结果</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-600">
            填入正文并生成后，这里会显示 A4 版式的实时预览。
            预览与导出使用同一份渲染结果，所见即所得。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── 工具条 ── */}
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
        <span className="text-xs text-ink-400">{docLabel}</span>
        <span className="text-ink-700">·</span>
        <span
          className={[
            'flex items-center gap-1 text-xs',
            pages > 1 ? 'text-warn-400' : 'text-teal-500',
          ].join(' ')}
        >
          {pages > 1 ? <FileWarning size={12} /> : null}
          {pages} 页
        </span>
        {pages > 1 ? (
          <span className="text-[11px] text-ink-600">（超过一页，打印会分页）</span>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => stepZoom(-1)}
            disabled={!canZoomOut}
            className="rounded p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-200 disabled:opacity-30"
            aria-label="缩小"
          >
            <ZoomOut size={14} />
          </button>
          <span className="w-10 text-center text-[11px] tabular-nums text-ink-400">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => stepZoom(1)}
            disabled={!canZoomIn}
            className="rounded p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-200 disabled:opacity-30"
            aria-label="放大"
          >
            <ZoomIn size={14} />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="rounded p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-200"
            aria-label="实际大小"
            title="实际大小（100%）"
          >
            <Maximize2 size={14} />
          </button>
        </div>
      </div>

      {/* ── 生成完成提示 ──
          需求：生成完成后在预览旁给出「生成完成」小提示
          （生成时间、供应商/模型、接口协议）+ 绿色打钩。
          同一份提示也出现在生成按钮下方，两处共用
          `GenerationDoneBar`，免得哪天改了文案只改一处。 */}
      <GenerationDoneBar type={docType} variant="attached" />

      {/* ── 下载区 ──
          需求：「先输出到下方预览板，右上角提供下载」 */}
      <div className="border-b border-ink-800 px-3 py-2">
        {/* 把页数传下去：分页导出与尺寸守卫都要用它。
            这个数由下面的 ResizeObserver 实测，比再算一遍可靠。 */}
        <ExportButtons type={docType} pages={pages} />
      </div>

      {/* ── 画布 ──
          缩放用 transform，因此量测高度时要用未缩放的原始高度，
          这里通过外层容器的高度推算，避免把缩放算进页数。

          底色用 bg-canvas 而不是 bg-ink-950：浅色主题下后者是纯白，
          白纸压白底会让纸张边界消失。canvas 在浅色下是中灰，
          深色下与页面同色（见 styles.css 的 token 注释）。 */}
      <div className="min-h-0 flex-1 overflow-auto bg-canvas p-6">
        <div className="flex justify-center">
          <div
            style={{
              width: A4_WIDTH_PX * zoom,
              height: (A4_HEIGHT_PX * pages) * zoom,
            }}
          >
            <div
              ref={contentRef}
              className="preview-doc"
              style={{
                width: A4_WIDTH_PX,
                transform: `scale(${zoom})`,
                transformOrigin: 'top left',
                // 页与页之间画一条虚线，让分页位置可见。
                // 颜色取自 --color-guide：深色下是金色、浅色下是蓝色，
                // 因为金色压中灰几乎看不见。
                backgroundImage:
                  pages > 1
                    ? `repeating-linear-gradient(to bottom, transparent 0, transparent ${
                        A4_HEIGHT_PX - 1
                      }px, var(--color-guide) ${A4_HEIGHT_PX - 1}px, var(--color-guide) ${A4_HEIGHT_PX}px)`
                    : undefined,
              }}
              // 渲染层产出的 HTML 已在内部对用户内容做了转义，
              // 且 DesignSpec 的字段受 zod 严格约束（颜色必须是 hex）。
              // 字体是唯一一处例外：用户自定义字体会越过白名单直接进样式表，
              // 所以拼字体栈时单独做了转义（见 `render.ts` 的 `fontStack`）。
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
