/**
 * 图片导入的纯函数部分。
 *
 * `prepareImage` 依赖 canvas / FileReader，	node 环境跑不了 ——
 * 但它内部用的每一个算术步骤都是独立的纯函数，那些才是最容易出错的
 * （字节换算、缩放比例、尺寸取整）。这里覆盖它们。
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_EDGE,
  base64Bytes,
  fitWithin,
  imageDisplayName,
  isAcceptedImageMime,
  parseDataUrl,
  pickImageFiles,
} from './image-import';

describe('data URL 解析', () => {
  it('拆出 MIME 与 base64', () => {
    expect(parseDataUrl('data:image/png;base64,aGVsbG8=')).toEqual({
      mime: 'image/png',
      dataBase64: 'aGVsbG8=',
    });
  });

  it('MIME 带参数时只取到分号为止', () => {
    // 直接 split(',') 会得到 'image/svg+xml;charset=utf-8' 当 MIME，端点是拒绝的。
    expect(parseDataUrl('data:image/svg+xml;charset=utf-8,PHN2Zz4=')?.mime).toBe('image/svg+xml');
  });

  it('去掉 base64 里的换行', () => {
    expect(parseDataUrl('data:image/png;base64,aGVs\nbG8=')?.dataBase64).toBe('aGVsbG8=');
  });

  it('不是 data URL 时返回 null', () => {
    expect(parseDataUrl('https://example.com/a.png')).toBeNull();
    expect(parseDataUrl('data:image/png;base64,')).toBeNull();
  });
});

describe('base64 字节数', () => {
  it('无填充：4 字符 3 字节', () => {
    expect(base64Bytes('aGVs')).toBe(3);
  });

  it('一个 = 扣 1 字节，两个 = 扣 2 字节', () => {
    expect(base64Bytes('aGVsbG8=')).toBe(5); // 'hello'
    expect(base64Bytes('aGk=')).toBe(2); // 'hi'
  });

  it('空串是 0', () => {
    expect(base64Bytes('')).toBe(0);
    expect(base64Bytes('   ')).toBe(0);
  });

  it('与真实字符串长度一致', () => {
    expect(base64Bytes(Buffer.from('hello').toString('base64'))).toBe(5);
    expect(base64Bytes(Buffer.from('中文内容').toString('base64'))).toBe(12);
  });
});

describe('按长边缩放', () => {
  it('小图原样保留，不放大', () => {
    expect(fitWithin(300, 200)).toEqual({ width: 300, height: 200, scaled: false });
  });

  it('超长边按比例缩到上限', () => {
    const r = fitWithin(3200, 1600);
    expect(r.scaled).toBe(true);
    expect(Math.max(r.width, r.height)).toBe(MAX_EDGE);
    expect(r.width / r.height).toBeCloseTo(2, 2);
  });

  it('极扁的图不会算出 0 边长', () => {
    // canvas 不接受 0 边长，Math.round 在这里会算出 0。
    const r = fitWithin(4000, 3);
    expect(r.width).toBe(MAX_EDGE);
    expect(r.height).toBeGreaterThanOrEqual(1);
  });

  it('零尺寸不会崩', () => {
    expect(fitWithin(0, 0)).toEqual({ width: 0, height: 0, scaled: false });
  });
});

describe('MIME 白名单', () => {
  it('认识四种常见格式，大小写不敏感', () => {
    expect(isAcceptedImageMime('image/png')).toBe(true);
    expect(isAcceptedImageMime('IMAGE/JPEG')).toBe(true);
    expect(isAcceptedImageMime('image/webp')).toBe(true);
    expect(isAcceptedImageMime('image/gif')).toBe(true);
  });

  it('拒绝 SVG 与 PDF —— 它们不是位图，重编码路径不适用', () => {
    expect(isAcceptedImageMime('image/svg+xml')).toBe(false);
    expect(isAcceptedImageMime('application/pdf')).toBe(false);
    expect(isAcceptedImageMime('')).toBe(false);
  });
});

describe('展示用名字', () => {
  it('有文件名就用文件名', () => {
    expect(imageDisplayName(1, '旧简历.png')).toBe('旧简历.png');
  });

  it('没有文件名时按序号生成', () => {
    expect(imageDisplayName(2)).toBe('剪贴板图片 2');
    expect(imageDisplayName(1, '   ')).toBe('剪贴板图片 1');
  });
});

describe('从拖放 / 粘贴事件里挑图片', () => {
  /** 造一个最小的 DataTransfer 替身。 */
  function transfer(opts: {
    items?: { kind: string; file: File | null }[];
    files?: File[];
  }): DataTransfer {
    return {
      items: (opts.items ?? []).map((i) => ({
        kind: i.kind,
        getAsFile: () => i.file,
      })),
      files: opts.files ?? [],
    } as unknown as DataTransfer;
  }

  const png = new File(['x'], 'a.png', { type: 'image/png' });
  const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });

  it('剪贴板截图在 items 里，也要能拿到', () => {
    // Chromium 粘贴截图时 files 常常是空的，只看 files 会漏掉。
    const out = pickImageFiles(transfer({ items: [{ kind: 'file', file: png }] }));
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('a.png');
  });

  it('资源管理器拖入的文件在 files 里', () => {
    const out = pickImageFiles(transfer({ files: [png] }));
    expect(out).toHaveLength(1);
  });

  it('同一个文件同时在两处时只算一次', () => {
    const out = pickImageFiles(
      transfer({ items: [{ kind: 'file', file: png }], files: [png] }),
    );
    expect(out).toHaveLength(1);
  });

  it('非图片被过滤掉', () => {
    const out = pickImageFiles(transfer({ files: [pdf] }));
    expect(out).toHaveLength(0);
  });

  it('没有 data 时返回空数组', () => {
    expect(pickImageFiles(null)).toEqual([]);
  });
});
