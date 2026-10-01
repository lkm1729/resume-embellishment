/**
 * 导出编排。
 *
 * ═══════════════════════════════════════════════════════════════
 *  一个关键约束：`PrintToPdfAsync` 打印的是**整个 webview**。
 *
 *  如果直接在当前界面上调用，导出的 PDF 里会有侧边栏、输入框、
 *  预览工具条 —— 那不是用户想要的东西。
 *
 *  所以导出流程是：
 *    1. 把界面切成「导出视图」：页面上只剩待导出的文档
 *    2. 等两帧绘制，确保 React 已经把它渲染出来
 *    3. 调用 Rust 打印
 *    4. 无论成败都切回正常界面
 *
 *  第 4 步必须放在 finally 里。否则一次失败就会让界面永久卡在
 *  "只剩文档"的状态 —— 用户会以为应用坏了。
 * ═══════════════════════════════════════════════════════════════
 */

import { save, open } from '@tauri-apps/plugin-dialog';
import { writeFile, readFile } from '@tauri-apps/plugin-fs';
import * as api from '@/core/llm/api';
import { toCommandError } from '@/core/llm/types';
import { A4_WIDTH_PX, A4_HEIGHT_PX } from '@/core/render/render';

/** 导出格式。 */
export type ExportFormat = 'pdf' | 'png' | 'docx';

/**
 * PNG 的清晰度倍率。
 *
 * 2x 是原来的固定值，作为默认以保持既有行为不变。
 */
export type PngScale = 1 | 2 | 3;

/** PNG 的版面：一张长图，还是每页一个文件。 */
export type PngLayout = 'long' | 'pages';

/** 各格式的默认文件名与说明。 */
export const FORMAT_META: Record<
  ExportFormat,
  { label: string; ext: string; hint: string }
> = {
  pdf: {
    label: 'PDF（矢量）',
    ext: 'pdf',
    hint: '文字可选中、可搜索，A4 精确分页。投递首选。',
  },
  png: {
    label: 'PNG（长图）',
    ext: 'png',
    hint: '整页长图，适合发消息或在网页上展示。',
  },
  docx: {
    label: 'Word（.docx）',
    ext: 'docx',
    hint: '近似还原版式，便于对方在线修改。多栏版式导出后会变成单栏。',
  },
};

/** 把文件名里的非法字符替换掉。 */
export function sanitizeFileName(name: string): string {
  return (
    name
      // Windows 文件名禁用字符
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || '未命名'
  );
}

/** 拼出建议的文件名。 */
export function suggestFileName(
  baseName: string,
  format: ExportFormat,
  date = new Date(),
): string {
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
    date.getDate(),
  ).padStart(2, '0')}`;
  return `${sanitizeFileName(baseName)}-${stamp}.${FORMAT_META[format].ext}`;
}

/** 当前平台的导出能力。 */
export interface ExportSupport {
  pdf: boolean;
  platform: string;
  note: string;
}

/** 查询平台支持情况。 */
export async function querySupport(): Promise<ExportSupport> {
  return api.exportSupport();
}

/**
 * canvas 的硬上限。
 *
 * WebView2 基于 Chromium，单边超过 65535px 或总面积超过约 268 Mpx 时
 * canvas 会**静默失败** —— `toBlob` 得到 null，而不是抛错。
 * 静默失败是最坏的一种：用户点了导出、看到"已导出"、打开却是空白图。
 * 所以必须在动手前先算，算出来超限就明确拒绝并说明怎么降级。
 *
 * 数值来源：Chromium 的 canvas 尺寸限制（单边 65535、总面积 16384²）。
 */
const CANVAS_MAX_SIDE = 65535;
const CANVAS_MAX_AREA = 16384 * 16384;

/**
 * 峰值内存预算（MB）。
 *
 * 长图模式下所有分页 canvas 会同时存活，再加一张合成图，共 N+1 张。
 * 超过这个量就该提醒用户 —— 不是不能做，而是会卡一下。
 */
const PEAK_MEMORY_BUDGET_MB = 800;

/** 超过这么多页就给性能提示（长图会明显变慢）。 */
const SLOW_PAGE_THRESHOLD = 10;

/** PNG 导出的尺寸预估与守卫结论。 */
export interface PngPlan {
  scale: PngScale;
  layout: PngLayout;
  pages: number;
  /** 单页像素尺寸。 */
  pageW: number;
  pageH: number;
  /** 长图模式下的合成尺寸；分页模式等于单页尺寸。 */
  outW: number;
  outH: number;
  /** 预估峰值内存（MB）。 */
  peakMB: number;
  /** 非空表示**不能**导出，内容是给用户看的原因。 */
  blocked: string | null;
  /** 非空表示可以导出但值得提醒。 */
  warning: string | null;
}

/**
 * 预估 PNG 导出的尺寸，并给出守卫结论。
 *
 * 纯计算，不做任何 IO —— 因此 UI 可以在用户点按钮之前就实时显示
 * 「3x 长图会触顶」这类提示，而不是等失败。
 */
export function planPng(pages: number, scale: PngScale, layout: PngLayout): PngPlan {
  const safePages = Math.max(1, Math.floor(pages));
  const pageW = Math.round(A4_WIDTH_PX * scale);
  const pageH = Math.round(A4_HEIGHT_PX * scale);

  // 长图：N 页纵向拼接
  const outW = layout === 'long' ? pageW : pageW;
  const outH = layout === 'long' ? pageH * safePages : pageH;

  const bytesPerCanvas = pageW * pageH * 4;
  // 长图模式：N 张分页 canvas + 1 张合成图同时存活
  // 分页模式：逐页写出、写完即释放，所以只有 1 张
  const aliveCanvases = layout === 'long' ? safePages + 1 : 1;
  const peakMB = Math.round((bytesPerCanvas * aliveCanvases) / 1024 / 1024);

  let blocked: string | null = null;
  let warning: string | null = null;

  if (outH > CANVAS_MAX_SIDE) {
    blocked =
      `合成图高度 ${outH}px 超过画布上限 ${CANVAS_MAX_SIDE}px。` +
      `当前 ${safePages} 页 × ${scale}x。请降低清晰度，或改用分页导出。`;
  } else if (outW * outH > CANVAS_MAX_AREA) {
    blocked =
      `合成图面积过大（${Math.round((outW * outH) / 1e6)} 百万像素，` +
      `上限 ${Math.round(CANVAS_MAX_AREA / 1e6)}）。请降低清晰度，或改用分页导出。`;
  } else if (peakMB > PEAK_MEMORY_BUDGET_MB) {
    blocked =
      `预估内存占用约 ${peakMB} MB，超过预算 ${PEAK_MEMORY_BUDGET_MB} MB。` +
      `请降低清晰度，或改用分页导出（分页是逐页写出，内存占用低得多）。`;
  } else if (layout === 'long' && safePages > SLOW_PAGE_THRESHOLD) {
    warning = `${safePages} 页长图在 ${scale}x 下需要拼接，会比较慢，请稍候。`;
  } else if (peakMB > PEAK_MEMORY_BUDGET_MB / 2) {
    warning = `预估内存占用约 ${peakMB} MB，低配机器上可能卡顿。`;
  }

  return {
    scale,
    layout,
    pages: safePages,
    pageW,
    pageH,
    outW,
    outH,
    peakMB,
    blocked,
    warning,
  };
}

/** 等两帧绘制，确保 DOM 变更已经反映到屏幕上。 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * 弹出保存对话框，返回用户选择的路径。
 *
 * 用户取消时返回 null —— 这不是错误，不该弹错误提示。
 */
export async function pickSavePath(
  defaultName: string,
  format: ExportFormat,
): Promise<string | null> {
  const meta = FORMAT_META[format];
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: meta.label, extensions: [meta.ext] }],
  });
  return path ?? null;
}

/**
 * 弹出目录选择对话框（分页导出用）。
 *
 * 用目录而不是让用户逐页选路径：一份五页的简历要弹五次保存框，
 * 那是折磨。
 *
 * 权限说明：tauri 的 dialog 插件会为选中的目录**运行时授予** fs 权限
 * （tauri-plugin-dialog 的 commands.rs 里调 `allow_directory`），
 * 所以随后的多次 writeFile 不需要额外的静态 scope 声明。
 */
export async function pickOutputDir(): Promise<string | null> {
  const dir = await open({ directory: true, multiple: false, title: '选择导出文件夹' });
  return typeof dir === 'string' ? dir : null;
}

/**
 * 导出 PDF。
 *
 * @param path       目标路径（由 pickSavePath 得到）
 * @param enterExportView 切到导出视图；返回一个「切回来」的函数
 */
export async function exportPdf(
  path: string,
  enterExportView: () => Promise<() => void>,
): Promise<void> {
  const restore = await enterExportView();
  try {
    // 等渲染落地再打印，否则可能打到上一帧的布局
    await nextPaint();
    await api.exportPdf(path);
  } catch (e) {
    throw new Error(toCommandError(e).message);
  } finally {
    // 必须无条件恢复：一次失败就卡住界面是不可接受的
    restore();
    await nextPaint();
  }
}

/**
 * 导出 PNG。
 *
 * 实现路径：**先把文档打成 PDF，再用 pdfjs 光栅化**。
 *
 * 为什么不直接截屏或用 html2canvas：
 *   · 截屏只能拿到视口，长文档要滚动拼接，且会受窗口尺寸影响；
 *   · html2canvas 需要重新实现一遍 CSS 渲染，字体与断行必然有偏差。
 * 走 PDF 光栅化则与矢量版**共用同一次渲染**，
 * 因此 PNG 与 PDF 的版式不可能不一致 —— 这正是我们要的性质。
 *
 * 两种版面：
 *   · long  —— 所有页纵向拼成一张长图（默认，原行为）
 *   · pages —— 每页一个文件，写进用户选定的文件夹
 *
 * 分页模式顺带解决了内存问题：它是**逐页写出、写完即释放**，
 * 因此峰值内存与页数无关（长图模式是 N+1 张 canvas 同时存活）。
 *
 * @returns 实际写出的文件路径（long 模式长度为 1）
 */
export async function exportPng(
  target: { path: string } | { dir: string; baseName: string },
  enterExportView: () => Promise<() => void>,
  scale: PngScale = 2,
  layout: PngLayout = 'long',
): Promise<string[]> {
  // 先导出到临时 PDF —— PDF 与 PNG 共用同一次渲染
  const tmpPdf = await tempPdfPath();

  const restore = await enterExportView();
  try {
    await nextPaint();
    await api.exportPdf(tmpPdf);
  } finally {
    restore();
    await nextPaint();
  }

  try {
    const bytes = await readFile(tmpPdf);
    return layout === 'long'
      ? [await writeLongImage(bytes, scale, (target as { path: string }).path)]
      : await writePageImages(bytes, scale, target as { dir: string; baseName: string });
  } finally {
    // 清理临时文件。失败不影响导出结果。
    try {
      const { remove } = await import('@tauri-apps/plugin-fs');
      await remove(tmpPdf);
    } catch {
      /* 临时文件残留可接受 */
    }
  }
}

/** 生成一个临时 PDF 路径（放在系统临时目录）。 */
async function tempPdfPath(): Promise<string> {
  const { tempDir, join } = await import('@tauri-apps/api/path');
  const dir = await tempDir();
  return join(dir, `re-export-${Date.now()}.pdf`);
}

/** 加载 pdfjs，并让它用打包进来的 worker。 */
async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  // worker 用打包进来的那份，避免运行时去网上取
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs;
}

/** pdfjs 的文档对象类型（从 getDocument 的返回值推导，避免手写一长串泛型）。 */
type PdfDoc = Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfjs>>['getDocument']>['promise']>;

/** 把一页渲染到独立 canvas。 */
async function renderPage(
  doc: PdfDoc,
  pageNo: number,
  scale: number,
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  // pdfjs v6 的约定：要么给 `canvas`，要么给 `canvasContext`（此时 canvas 必须为 null）。
  // 两个都给是歧义用法，因此这里只给 `canvas`，背景色用 `background` 参数指定。
  // 不显式指定背景会得到透明 PNG —— 在深色聊天窗口里看起来就是"图片坏了"。
  await page.render({ canvas, viewport, background: '#ffffff' }).promise;
  return canvas;
}

/**
 * 长图：所有页纵向拼成一张，写到指定路径。
 */
async function writeLongImage(
  bytes: Uint8Array,
  scale: number,
  path: string,
): Promise<string> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;

  const canvases: HTMLCanvasElement[] = [];
  let totalHeight = 0;
  let maxWidth = 0;

  for (let i = 1; i <= doc.numPages; i++) {
    const canvas = await renderPage(doc, i, scale);
    canvases.push(canvas);
    totalHeight += canvas.height;
    maxWidth = Math.max(maxWidth, canvas.width);
  }

  // 动手前再守一次：这里若超限，toBlob 会静默返回 null，
  // 用户会看到"导出成功"却拿到空白图。
  if (totalHeight > CANVAS_MAX_SIDE || maxWidth * totalHeight > CANVAS_MAX_AREA) {
    throw new Error(
      `合成图尺寸 ${maxWidth}×${totalHeight} 超出画布上限，无法生成。` +
        `请降低清晰度或改用分页导出。`,
    );
  }

  const out = document.createElement('canvas');
  out.width = maxWidth;
  out.height = totalHeight;
  const outCtx = out.getContext('2d');
  if (!outCtx) throw new Error('无法创建输出 canvas');

  outCtx.fillStyle = '#ffffff';
  outCtx.fillRect(0, 0, out.width, out.height);

  let y = 0;
  for (const c of canvases) {
    outCtx.drawImage(c, 0, y);
    y += c.height;
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    out.toBlob((b) => resolve(b), 'image/png'),
  );
  if (!blob) throw new Error('PNG 编码失败');

  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return path;
}

/**
 * 分页：每页一个文件，写进用户选定的目录。
 *
 * 文件名形如 `张伟-简历-01.png`。补零是为了让文件管理器按名称排序时
 * 顺序正确（否则第 10 页会排在第 2 页前面）。
 */
async function writePageImages(
  bytes: Uint8Array,
  scale: number,
  target: { dir: string; baseName: string },
): Promise<string[]> {
  const { join } = await import('@tauri-apps/api/path');
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;

  const base = sanitizeFileName(target.baseName);
  const pad = String(doc.numPages).length;
  const written: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const canvas = await renderPage(doc, i, scale);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png'),
    );
    if (!blob) throw new Error(`第 ${i} 页 PNG 编码失败`);

    const name = `${base}-${String(i).padStart(pad, '0')}.png`;
    const full = await join(target.dir, name);
    await writeFile(full, new Uint8Array(await blob.arrayBuffer()));
    written.push(full);

    // 显式释放：分页模式的低内存特性正来自这里。
    // 不置零尺寸的话，canvas 的显存要等 GC 才回收，
    // 页数多时峰值会悄悄涨回去。
    canvas.width = 0;
    canvas.height = 0;
  }

  return written;
}
