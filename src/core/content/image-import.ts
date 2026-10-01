/**
 * 图片导入：把剪贴板 / 拖放 / 文件选择得到的图片变成可以随请求发给模型的数据。
 *
 * ═══════════════════════════════════════════════════════════════
 *  为什么单独成文件：和 `file-import.ts` 同样的理由 —— **要能被测试**。
 *  这里的每一步（挑出图片、缩到合理尺寸、重编码、算大小）都是纯函数式的
 *  数据变换，除了 canvas 那一层。把 canvas 收在 `encode` 里，
 *  其余逻辑就都能在 node 环境下直接跑断言。
 * ═══════════════════════════════════════════════════════════════
 *
 * ⚠ 压缩不是「优化」，是**必需**。
 * 一张 4K 截图原样 base64 之后接近 10MB，塞进请求体有两个后果：
 * 请求超时（180 秒也未必够），以及大多数端点直接回 413/400。
 * 而设计参考图只需要看清版式结构 —— 1600px 长边绰绰有余。
 */

/** 送给模型前允许的最大长边（像素）。 */
export const MAX_EDGE = 1600;

/** 重编码质量。0.82 是肉眼几乎无损与体积之间的常见平衡点。 */
export const JPEG_QUALITY = 0.82;

/** 压缩后允许的最大 base64 长度（字符）。超过就再压一轮，仍超则拒绝。 */
export const MAX_BASE64_CHARS = 4_000_000;

/** 认可的输入 MIME。 */
export const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export const IMAGE_ACCEPT_ATTR = 'image/png,image/jpeg,image/webp,image/gif';

/** 一张已经准备好下发的图片。 */
export interface ImportedImage {
  /** 展示用名字。 */
  fileName: string;
  /** 下发时写在 data URL 前缀里的 MIME。压缩后实际是这个类型。 */
  mime: string;
  /** 纯 base64，不含 `data:` 前缀。 */
  dataBase64: string;
  /** 原始字节数。 */
  size: number;
  /** 压缩后的字节数。 */
  storedSize: number;
  /** 压缩时产生的提示（尺寸被缩小、格式被转换），需要如实告诉用户。 */
  warning?: string;
}

/** 导入失败时抛这个，带可操作的中文说明。 */
export class ImageImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageImportError';
  }
}

/** 这个 MIME 是不是我们认识的图片。 */
export function isAcceptedImageMime(mime: string): boolean {
  return (ACCEPTED_MIME as readonly string[]).includes(mime.toLowerCase());
}

/**
 * 从一段 `data:` URL 里拆出 MIME 与 base64。
 *
 * 用正则而不是 `split(',')`：base64 本身不含逗号，但 MIME 段可能带参数
 * （`data:image/svg+xml;charset=utf-8,...`），split 出来的第一段带分号，
 * 直接当 MIME 用会被端点拒绝。这里只取到第一个 `;` 或 `,` 为止。
 */
export function parseDataUrl(dataUrl: string): { mime: string; dataBase64: string } | null {
  const match = /^data:([^;,]+)[^,]*,([\s\S]*)$/.exec(dataUrl.trim());
  if (!match) return null;
  const mime = (match[1] ?? '').trim().toLowerCase();
  const dataBase64 = (match[2] ?? '').replace(/\s+/g, '');
  if (mime.length === 0 || dataBase64.length === 0) return null;
  return { mime, dataBase64 };
}

/**
 * base64 字符串对应的字节数。
 *
 * 每 4 个字符是 3 字节，末尾的 `=` 各扣掉 1 字节。
 * 用它而不是 `atob().length`：后者要为一张 4MB 的图额外分配一个
 * 同等大小的字符串，而这里只是算术。
 */
export function base64Bytes(dataBase64: string): number {
  const clean = dataBase64.replace(/\s+/g, '');
  if (clean.length === 0) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/**
 * 按长边上限算出目标尺寸。
 *
 * 只缩不放：一张 300px 的小图放大到 1600px 只会变糊，还更占带宽。
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge = MAX_EDGE,
): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) {
    return { width, height, scaled: false };
  }
  const ratio = maxEdge / longest;
  return {
    // 至少留 1px：Math.round 对极扁的图可能算出 0，而 canvas 不接受 0 边长。
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

/** 展示用名字：从文件名或序号生成。 */
export function imageDisplayName(index: number, fileName?: string): string {
  const trimmed = (fileName ?? '').trim();
  if (trimmed.length > 0) return trimmed;
  return `剪贴板图片 ${index}`;
}

/**
 * 从 `DataTransfer` / `ClipboardEvent.clipboardData` 里挑出图片文件。
 *
 * ⚠ 必须同时看 `items` 和 `files`。
 * 从剪贴板粘贴截图时，Chromium 把它放在 `items` 里（且 `files` 常常是空的）；
 * 从资源管理器拖进来时，它只在 `files` 里。两个都查才对两种入口都成立。
 */
export function pickImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];

  const out: File[] = [];
  const seen = new Set<string>();

  const push = (f: File | null) => {
    if (!f) return;
    if (!isAcceptedImageMime(f.type)) return;
    // 同一个文件可能同时出现在 items 与 files 里，按「名字+大小」去重。
    const key = `${f.name}|${f.size}|${f.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };

  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file') push(item.getAsFile());
  }
  for (const f of Array.from(data.files ?? [])) push(f);

  return out;
}

// ─────────────────────────── 压缩 ───────────────────────────

/** 读成 data URL 的替身，便于测试时替换掉 FileReader。 */
type ReadAsDataUrl = (blob: Blob) => Promise<string>;

const readAsDataUrl: ReadAsDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new ImageImportError('读不出这个文件的内容。'));
    reader.readAsDataURL(blob);
  });

/** 解码成可绘制的位图。 */
async function decode(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new ImageImportError('这个文件不是浏览器能识别的图片格式，或者已经损坏。'));
    img.src = dataUrl;
  });
}

/**
 * 把一张图片压到可下发的尺寸。
 *
 * 一律重编码成 JPEG，除了带透明通道的 PNG —— 那些转 JPEG 会把透明区域
 * 变成黑块，版式参考图上出现黑块比多占几百 KB 更糟。
 *
 * 若一次压缩后仍超限，会把长边减半再试，最多三轮；仍超限就报错，
 * 而不是把一个注定被端点拒绝的请求发出去。
 */
export async function prepareImage(
  file: File,
  index: number,
): Promise<ImportedImage> {
  if (!isAcceptedImageMime(file.type)) {
    throw new ImageImportError(
      `「${file.name}」不是支持的图片格式。可以用 PNG / JPEG / WebP / GIF。`,
    );
  }

  const original = await readAsDataUrl(file);
  const parsed = parseDataUrl(original);
  if (!parsed) {
    throw new ImageImportError(`「${file.name}」的内容不是合法的图片数据。`);
  }

  const img = await decode(original);
  const notes: string[] = [];

  // 带透明的 PNG 保留 PNG，其余一律走 JPEG。
  const keepPng = parsed.mime === 'image/png' && (await hasTransparency(img));
  const targetMime = keepPng ? 'image/png' : 'image/jpeg';

  let maxEdge = MAX_EDGE;
  let result: { mime: string; dataBase64: string } | null = null;

  for (let round = 0; round < 3; round++) {
    const size = fitWithin(img.naturalWidth, img.naturalHeight, maxEdge);
    result = await encode(img, size.width, size.height, targetMime);
    if (result.dataBase64.length <= MAX_BASE64_CHARS) break;
    if (round === 0) {
      notes.push('图片很大，已缩小尺寸');
    }
    maxEdge = Math.floor(maxEdge / 2);
    result = null;
  }

  if (!result) {
    throw new ImageImportError(
      `「${file.name}」压缩后仍然太大。请先裁剪到只保留需要的部分，或改用截图工具重新截取。`,
    );
  }

  const storedSize = base64Bytes(result.dataBase64);
  if (storedSize < file.size) {
    const saved = Math.round((1 - storedSize / file.size) * 100);
    if (saved >= 10) notes.push(`已压缩到原大小的 ${100 - saved}%`);
  }

  const scaled =
    img.naturalWidth > MAX_EDGE || img.naturalHeight > MAX_EDGE;
  if (scaled && !notes.some((n) => n.includes('缩小'))) {
    notes.push(`已缩到长边 ${MAX_EDGE}px`);
  }

  return {
    fileName: imageDisplayName(index, file.name),
    mime: result.mime,
    dataBase64: result.dataBase64,
    size: file.size,
    storedSize,
    ...(notes.length > 0 ? { warning: notes.join('；') } : {}),
  };
}

/**
 * 这张图有没有真正用到的透明像素。
 *
 * 为了速度只看 alpha 通道，且每隔若干像素抽样 —— 设计参考图里
 * 有没有透明区域是"一眼可见"的属性，抽 1/16 的像素就足够判断，
 * 而全量扫描一张 4K 图会让导入卡顿好几秒。
 */
async function hasTransparency(img: HTMLImageElement): Promise<boolean> {
  const canvas = document.createElement('canvas');
  const w = Math.min(img.naturalWidth, 256);
  const h = Math.min(img.naturalHeight, 256);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.drawImage(img, 0, 0, w, h);
  try {
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! < 255) return true;
    }
  } catch {
    // 跨域图片会让 getImageData 抛错；此时按「不透明」处理，
    // 结果是转成 JPEG —— 对一张本地导入的图来说这个降级无所谓。
    return false;
  }
  return false;
}

/** 画进 canvas 再导出。 */
async function encode(
  img: HTMLImageElement,
  width: number,
  height: number,
  mime: string,
): Promise<{ mime: string; dataBase64: string }> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new ImageImportError('无法创建画布来处理这张图片。请改用桌面应用重试。');
  }

  const isJpeg = mime === 'image/jpeg';
  if (isJpeg) {
    // JPEG 没有透明通道，先铺白底，否则透明区域会变成黑块。
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(img, 0, 0, width, height);

  const dataUrl = canvas.toDataURL(mime, isJpeg ? JPEG_QUALITY : undefined);
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    throw new ImageImportError('图片重编码失败。请换一张图，或改用 PNG 格式。');
  }
  return { mime: parsed.mime, dataBase64: parsed.dataBase64 };
}

/** 人类可读的大小。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
