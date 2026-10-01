/**
 * 极简 ZIP 读取器 —— 只为从 DOCX 里取出需要的 XML。
 *
 * ═══════════════════════════════════════════════════════════════
 *  为什么不直接 import jszip：
 *
 *  `jszip` 目前只是 `docx` 包的**间接依赖**（docx → jszip），
 *  本项目并未声明它。直接引用一个没声明的包，
 *  会在某次依赖升级悄悄换掉 docx 的实现后无声地崩掉。
 *  要么把它提成正式依赖，要么不依赖它。
 *
 *  DOCX 需要的其实只是"从一个 zip 里读几个条目"，
 *  而解压本身有平台 API（`DecompressionStream('deflate-raw')`，
 *  浏览器与 Node 都支持）。所以这里只补上 ZIP 的目录解析这一小段。
 * ═══════════════════════════════════════════════════════════════
 *
 * 支持的子集（DOCX 实际会用到的部分）：
 *   · 压缩方式 0（stored）与 8（deflate）
 *   · 一律从**中央目录**读取条目信息 —— 这样即使某个条目用了
 *     data descriptor（本地头里的大小写 0），也能拿到真实大小
 *
 * 明确不支持：加密、ZIP64、分卷压缩。
 * 遇到这些情况**抛出可读的错误**，而不是返回一个看似正常的结果 ——
 * 抽取失败被当成"文档是空的"是最坏的失败方式。
 */

/** 中央目录结束记录（EOCD）的签名。 */
const EOCD_SIG = 0x06054b50;
/** 中央目录文件头签名。 */
const CD_SIG = 0x02014b50;
/** 本地文件头签名。 */
const LOCAL_SIG = 0x04034b50;

/** EOCD 固定部分长度（不含注释）。 */
const EOCD_MIN_SIZE = 22;
/** 注释最大长度，决定向前搜索 EOCD 的范围。 */
const MAX_COMMENT = 0xffff;

/** 压缩方式。 */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** 读小端 u16。越界返回 0（调用前都已做过长度校验）。 */
function u16(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
}

/** 读小端 u32。用 >>> 0 转成无符号，避免最高位被解释成负数。 */
function u32(b: Uint8Array, o: number): number {
  return (
    ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0
  );
}

/** 一个条目的元信息。 */
export interface ZipEntryMeta {
  name: string;
  /** 压缩方式（0 = 未压缩，8 = deflate）。 */
  method: number;
  /** 压缩后大小。 */
  compressedSize: number;
  /** 原始大小。 */
  size: number;
  /** 本地文件头的偏移，用于定位数据。 */
  localOffset: number;
}

/** 解压失败或格式不支持时抛出。消息面向用户，可直接展示。 */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

/** 从尾部向前找 EOCD。ZIP 允许尾部有注释，因此不能只看最后一个字节。 */
function findEocd(b: Uint8Array): number {
  const earliest = Math.max(0, b.length - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let i = b.length - EOCD_MIN_SIZE; i >= earliest; i--) {
    if (u32(b, i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 列出压缩包内的全部条目。
 *
 * @throws {ZipError} 文件不是 ZIP、使用了 ZIP64/加密等不支持的特性
 */
export function listZipEntries(bytes: Uint8Array): ZipEntryMeta[] {
  const eocd = findEocd(bytes);
  if (eocd < 0) {
    throw new ZipError('这个文件不是有效的 DOCX（找不到 ZIP 目录）。');
  }

  const total = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);

  // ZIP64 会把大小/偏移写成 0xFFFFFFFF，真实值放在额外的字段里。
  // 我们不解 ZIP64 —— 但必须**识别出来并报错**，
  // 否则会拿着一个伪造的偏移去读，得到莫名其妙的结果。
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || total === 0xffff) {
    throw new ZipError('这个 DOCX 使用了 ZIP64 格式，暂不支持。');
  }
  if (cdOffset + cdSize > bytes.length) {
    throw new ZipError('这个 DOCX 的 ZIP 目录越界，文件可能已损坏。');
  }

  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntryMeta[] = [];
  let p = cdOffset;

  for (let i = 0; i < total; i++) {
    if (u32(bytes, p) !== CD_SIG) {
      throw new ZipError('这个 DOCX 的 ZIP 目录已损坏（条目签名不匹配）。');
    }

    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const compressedSize = u32(bytes, p + 20);
    const size = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const localOffset = u32(bytes, p + 42);

    // bit 0 表示条目已加密。
    if ((flags & 0x1) !== 0) {
      throw new ZipError('这个 DOCX 已加密，无法读取内容。');
    }

    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressedSize, size, localOffset });

    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/** 用平台 API 解 deflate-raw 流。 */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 读出某个条目的内容。条目不存在时返回 null。
 *
 * 注意：调用方要自己区分"没有这个条目"（正常，比如某些 DOCX 没有
 * numbering.xml）与"解压失败"（异常）。
 */
export async function readZipEntry(bytes: Uint8Array, name: string): Promise<Uint8Array | null> {
  const entry = listZipEntries(bytes).find((e) => e.name === name);
  if (!entry) return null;

  const local = entry.localOffset;
  if (u32(bytes, local) !== LOCAL_SIG) {
    throw new ZipError(`条目「${name}」的本地头已损坏。`);
  }

  // 本地头里的文件名/额外字段长度可能与中央目录不同，必须读本地的那份
  // 才能算出数据起点。
  const nameLen = u16(bytes, local + 26);
  const extraLen = u16(bytes, local + 28);
  const start = local + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;

  if (end > bytes.length) {
    throw new ZipError(`条目「${name}」的数据越界，文件可能已损坏。`);
  }

  const raw = bytes.subarray(start, end);

  if (entry.method === METHOD_STORE) return raw;
  if (entry.method === METHOD_DEFLATE) return await inflateRaw(raw);

  throw new ZipError(`条目「${name}」使用了不支持的压缩方式（${entry.method}）。`);
}
