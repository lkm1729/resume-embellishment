/**
 * 导出状态。
 *
 * `exporting` 是这里的核心状态：它为 true 时，
 * App 只渲染待导出的文档，把侧边栏、输入区、工具条全部撤掉。
 *
 * 为什么放在 store 而不是组件本地 state：
 * 切换导出视图的是「导出按钮」（在输入区里），
 * 而响应它的是「App 的根渲染」。两者不在同一棵子树上，
 * 用 store 是最直接的通信方式。
 */

import { create } from 'zustand';
import { writeFile } from '@tauri-apps/plugin-fs';
import type { DocType } from './workbench';
import type { ContentUnit } from '@/core/content/types';
import type { DesignSpec } from '@/core/design/spec';
import { renderDocument } from '@/core/render/render';
import {
  exportPdf,
  exportPng,
  pickOutputDir,
  pickSavePath,
  suggestFileName,
  type ExportFormat,
  type PngLayout,
  type PngScale,
} from '@/core/export/export';
import { toCommandError } from '@/core/llm/types';

/** PNG 的可调参数（PDF 用不到，Word 也用不到）。 */
export interface PngOptions {
  scale: PngScale;
  layout: PngLayout;
}

/** 默认值刻意与改动前保持一致：2x 长图。 */
export const DEFAULT_PNG_OPTIONS: PngOptions = { scale: 2, layout: 'long' };

interface ExportState {
  /** 非 null 时，App 只渲染这份文档。 */
  exporting: {
    html: string;
    /** 用于显示"正在导出…" */
    format: ExportFormat;
  } | null;
  /** 导出进行中的格式（UI 用它禁用按钮）。 */
  busy: Record<DocType, ExportFormat | null>;
  /** 最近一次导出的结果说明。 */
  notice: Record<DocType, string | null>;
  error: Record<DocType, string | null>;

  /** PNG 参数。记住上次选择，避免每次重设。 */
  png: PngOptions;
  setPng: (opts: Partial<PngOptions>) => void;

  /**
   * 导出。
   *
   * @param baseName 文件名主体（如「张伟-简历」）
   */
  run: (
    type: DocType,
    format: ExportFormat,
    units: readonly ContentUnit[],
    spec: DesignSpec,
    baseName: string,
  ) => Promise<void>;

  /** 导出视图期间由 App 读取的 HTML。 */
  clearNotice: (type: DocType) => void;
}

export const useExportStore = create<ExportState>((set, get) => ({
  exporting: null,
  busy: { resume: null, 'cover-letter': null },
  notice: { resume: null, 'cover-letter': null },
  error: { resume: null, 'cover-letter': null },
  png: DEFAULT_PNG_OPTIONS,

  setPng(opts) {
    set({ png: { ...get().png, ...opts } });
  },

  async run(type, format, units, spec, baseName) {
    set({
      busy: { ...get().busy, [type]: format },
      error: { ...get().error, [type]: null },
      notice: { ...get().notice, [type]: null },
    });

    try {
      const { scale, layout } = get().png;
      const paginated = format === 'png' && layout === 'pages';

      // 1. 先让用户选路径。取消就安静地结束 —— 取消不是错误。
      //    分页导出选的是**文件夹**，否则五页简历要弹五次保存框。
      let path: string | null = null;
      let dir: string | null = null;

      if (format === 'docx') {
        // Word 只需要主体名，路径照旧
        path = await pickSavePath(suggestFileName(baseName, format), format);
      } else if (paginated) {
        dir = await pickOutputDir();
      } else {
        path = await pickSavePath(suggestFileName(baseName, format), format);
      }

      if (!path && !dir) {
        set({ busy: { ...get().busy, [type]: null } });
        return;
      }

      // 2. 导出时用的 HTML：与预览同源，只是不含预览的缩放容器
      const html = renderDocument(units, spec, { includeStyle: true });

      /** 切到导出视图，返回恢复函数。 */
      const enterExportView = async (): Promise<() => void> => {
        set({ exporting: { html, format } });
        return () => set({ exporting: null });
      };

      let notice: string;

      if (format === 'pdf') {
        await exportPdf(path!, enterExportView);
        notice = `已导出到 ${path}`;
      } else if (format === 'png') {
        // 分页导出时文件名不带 .png 后缀（那是每页各自加的）
        const written = await exportPng(
          paginated ? { dir: dir!, baseName: `${baseName}-${dateStamp()}` } : { path: path! },
          enterExportView,
          scale,
          layout,
        );
        notice =
          written.length === 1
            ? `已导出到 ${written[0]}`
            : `已导出 ${written.length} 页到 ${dir}`;
      } else {
        // DOCX 不走打印管线：它由 docx 库直接构建，与 webview 无关
        const { buildDocx } = await import('@/core/export/docx');
        const blob = await buildDocx(units, spec);
        await writeFile(path!, new Uint8Array(await blob.arrayBuffer()));
        notice = `已导出到 ${path}`;
      }

      set({
        busy: { ...get().busy, [type]: null },
        notice: { ...get().notice, [type]: notice },
      });
    } catch (e) {
      set({
        busy: { ...get().busy, [type]: null },
        // 出错时确保退出导出视图，否则界面会卡住
        exporting: null,
        error: { ...get().error, [type]: toCommandError(e).message },
      });
    }
  },

  clearNotice(type) {
    set({ notice: { ...get().notice, [type]: null } });
  },
}));

/** 与 suggestFileName 同一套日期格式，供分页导出的文件名主体复用。 */
function dateStamp(date = new Date()): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}
