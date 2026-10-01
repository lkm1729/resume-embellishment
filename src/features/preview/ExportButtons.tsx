/**
 * 导出按钮组。
 *
 * 需求要求「先输出到下方预览板，右上角提供下载」——
 * 所以这里只负责触发，产物落在预览板的工具栏上（见 PreviewPanel）。
 *
 * 一个刻意的设计：**不支持导出的格式直接禁用并说明原因**，
 * 而不是让用户点了之后收到失败。平台能力在启动时探测一次。
 *
 * PNG 多两个参数（清晰度、长图/分页），并**实时**显示尺寸守卫结论：
 * 用户把清晰度调到 3x 时会立刻看到「会超出画布上限」，
 * 而不是点下去才失败 —— 那种失败还会静默产出空白图。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Download,
  FileText,
  Image as ImageIcon,
  FileType2,
  Loader2,
  TriangleAlert,
} from 'lucide-react';
import type { DocType } from '@/core/store/workbench';
import { useExportStore } from '@/core/store/export';
import { useWorkbenchStore } from '@/core/store/workbench';
import { useEffectiveSpec } from '@/core/fonts/effective';
import { GoogleDocsBar } from '@/features/google/GoogleDocsBar';
import {
  planPng,
  querySupport,
  type ExportFormat,
  type ExportSupport,
  type PngScale,
} from '@/core/export/export';

/** 各格式的图标。 */
const ICONS: Record<ExportFormat, typeof FileText> = {
  pdf: FileText,
  png: ImageIcon,
  docx: FileType2,
};

const SCALE_LABEL: Record<PngScale, string> = {
  1: '1x 屏幕',
  2: '2x 默认',
  3: '3x 印刷',
};

export function ExportButtons({ type, pages = 1 }: { type: DocType; pages?: number }) {
  // 导出必须用**叠加过用户字体选择**的 spec —— 否则用户在方块 7
  // 挑的字体在预览里是对的，导出的文件里却变回去了。
  const spec = useEffectiveSpec(type);
  const parsed = useWorkbenchStore((s) => s.parsed[type]);
  const busy = useExportStore((s) => s.busy[type]);
  const error = useExportStore((s) => s.error[type]);
  const notice = useExportStore((s) => s.notice[type]);
  const run = useExportStore((s) => s.run);
  const png = useExportStore((s) => s.png);
  const setPng = useExportStore((s) => s.setPng);

  const [support, setSupport] = useState<ExportSupport | null>(null);

  useEffect(() => {
    void querySupport()
      .then(setSupport)
      .catch(() => {
        // 拿不到能力信息时不阻止用户尝试，只是不显示平台说明
        setSupport(null);
      });
  }, []);

  const ready = !!spec && !!parsed;

  // 三种格式都可选：Word 一开始只在求职信上开放，但导出通路
  // （`buildDocx` / 导出 store 的 docx 分支）本来就与文档类型无关，
  // 限制它的只是 UI 这一行 —— 简历同样需要一份能改的 Word。
  const formats: ExportFormat[] = ['pdf', 'png', 'docx'];

  /**
   * Word 的分栏缺口。分栏板块**导出后一定会变成单栏** ——
   * `buildDocx` 不读分栏（Word 里没有 grid，硬做要手工算文本框位置，得不偿失）。
   * 这是已知缺口，与其让用户导完才发现，不如点之前就说清楚。
   *
   * ⚠ 判据是**板块级**的 `section.style.columns === 2`，不是 `layout.template`。
   * 真正把版面分成两栏的是 `render.ts` 里那个 `cols-2` 类
   * （`grid-template-columns: 1fr 1fr`），而 `layout.template` 只被写成一个
   * `data-template` 属性，全项目没有任何样式或代码消费它 —— 四个取值
   * 对画面毫无影响。按 `template` 判断会漏掉最常见的那种组合：
   * 本地兜底版式恒为 `single-column`，可它的板块仍可能是两栏，
   * 于是提示不出现、分栏却真的丢了。
   */
  const multiColumn = !!spec && spec.sections.some((s) => s.style.columns === 2);

  const docxTitle = multiColumn
    ? 'Word 只能近似还原：这个版式里有分栏板块，导出后会变成单栏。字体、字号层级、配色、间距会保留。'
    : 'Word 近似还原版式，便于对方在线修改';

  /** 文件名主体：优先用姓名，退化到文档类型。 */
  const baseName = (() => {
    const nameUnit = parsed?.units.find((u) => u.meta?.role === 'name');
    const who = nameUnit?.text.trim() ?? '';
    const what = type === 'resume' ? '简历' : '求职信';
    return who ? `${who}-${what}` : what;
  })();

  // 尺寸守卫：纯计算、无 IO，所以能随参数即时更新，
  // 用户调档位时立刻看到后果。
  const plan = useMemo(() => planPng(pages, png.scale, png.layout), [pages, png]);

  const handleExport = (format: ExportFormat) => {
    if (!spec || !parsed) return;
    void run(type, format, parsed.units, spec, baseName);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs text-ink-400">
          <Download size={13} />
          导出
        </span>

        {formats.map((f) => {
          const Icon = ICONS[f];
          const isBusy = busy === f;
          // 只有 PNG 受尺寸守卫影响
          const blockedByPlan = f === 'png' && !!plan.blocked;
          const disabled =
            !ready || busy !== null || (f === 'pdf' && support?.pdf === false) || blockedByPlan;

          return (
            <button
              key={f}
              type="button"
              onClick={() => handleExport(f)}
              disabled={disabled}
              title={
                blockedByPlan
                  ? plan.blocked!
                  : f === 'pdf' && support?.pdf === false
                    ? support.note
                    : f === 'docx'
                      ? docxTitle
                      : undefined
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isBusy ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} />}
              {f === 'pdf' ? 'PDF' : f === 'png' ? 'PNG' : 'Word'}
            </button>
          );
        })}

        {!ready ? (
          <span className="text-[11px] text-ink-600">先生成版式才能导出</span>
        ) : null}
      </div>

      {/*
        第四条出口。它不是 `ExportFormat` 的一员：前三个都要用户先挑
        一个存放位置（走导出 store 的 `run(type, format, …)`），
        这一个的目标在云端，自己去开浏览器。塞进 formats 数组会让
        `run` 里多出一个「不是文件」的分支，代价比这里多一行大。
      */}
      {ready && spec && parsed ? (
        <GoogleDocsBar
          units={parsed.units}
          spec={spec}
          baseName={baseName}
        />
      ) : null}

      {/* ── PNG 参数（仅在有结果时显示，否则是噪音）── */}
      {ready ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-ink-800 bg-ink-950/40 px-2.5 py-2">
          <span className="text-[11px] text-ink-600">PNG</span>

          <div className="flex items-center gap-1">
            <span className="text-[10px] text-ink-600">清晰度</span>
            <div className="inline-flex overflow-hidden rounded border border-ink-700">
              {([1, 2, 3] as PngScale[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setPng({ scale: s })}
                  className={[
                    'px-2 py-0.5 text-[10px] transition-colors',
                    png.scale === s
                      ? 'bg-ink-700 text-ink-200'
                      : 'text-ink-400 hover:bg-ink-800 hover:text-ink-300',
                  ].join(' ')}
                  title={SCALE_LABEL[s]}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-[10px] text-ink-600">版面</span>
            <div className="inline-flex overflow-hidden rounded border border-ink-700">
              {(
                [
                  ['long', '长图'],
                  ['pages', '分页'],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setPng({ layout: v })}
                  className={[
                    'px-2 py-0.5 text-[10px] transition-colors',
                    png.layout === v
                      ? 'bg-ink-700 text-ink-200'
                      : 'text-ink-400 hover:bg-ink-800 hover:text-ink-300',
                  ].join(' ')}
                  title={
                    v === 'long'
                      ? '所有页纵向拼成一张长图'
                      : '每页一个文件，导出到选定文件夹（内存占用更低）'
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 输出尺寸：让"清晰度"这个抽象档位有个具体落点 */}
          <span className="text-[10px] tabular-nums text-ink-600">
            {plan.layout === 'long'
              ? `${plan.pages} 页 → ${plan.outW}×${plan.outH}`
              : `${plan.pages} 个文件 · 每页 ${plan.outW}×${plan.outH}`}
          </span>
        </div>
      ) : null}

      {/*
        分栏缺口常驻一行，而不是只挂在按钮的 title 上 ——
        title 要悬停才出现，触屏、键盘和读屏用户根本拿不到。
      */}
      {ready && multiColumn ? (
        <p className="text-[11px] leading-relaxed text-ink-600">
          这个版式里有分栏板块。导出的 Word 会是单栏 —— Word 没有网格布局，分栏只能手工排文本框。
          PDF 和 PNG 不受影响。
        </p>
      ) : null}

      {/* 守卫结论：不能导出时说清原因与出路 */}
      {plan.blocked ? (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-warn-400">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          {plan.blocked}
        </p>
      ) : plan.warning ? (
        <p className="text-[11px] leading-relaxed text-ink-600">{plan.warning}</p>
      ) : null}

      {support && !support.pdf ? (
        <p className="text-[11px] leading-relaxed text-warn-400">{support.note}</p>
      ) : null}

      {notice ? (
        <p className="break-all text-[11px] leading-relaxed text-teal-500">{notice}</p>
      ) : null}

      {error ? (
        <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-rose-500">
          {error}
        </p>
      ) : null}
    </div>
  );
}
