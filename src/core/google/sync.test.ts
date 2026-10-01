import { describe, expect, it } from 'vitest';

import { bytesToBase64 } from './sync';

/**
 * 这一组测的不是「有没有 base64 函数」，而是**前端编出来的那几个字符
 * 和 Rust 侧 `BASE64_STANDARD.decode` 的期望是不是同一个东西**。
 *
 * 两边对不上的后果不是崩溃，是用户点了「同步到 Google Docs」、
 * 浏览器授权走完、上传到一半，然后收到一句
 * 「这份 Word 数据读不出来，可能传输时损坏了。」—— 一句把责任
 * 推给传输、却其实是编码选错了的提示。
 */

/** ASCII 字符串 → 字节。测试里只需要这一个方向。 */
function ascii(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

describe('bytesToBase64', () => {
  it('matches the RFC 4648 vectors', () => {
    // RFC 4648 §10 的官方样例，一个不多一个不少。
    expect(bytesToBase64(ascii(''))).toBe('');
    expect(bytesToBase64(ascii('f'))).toBe('Zg==');
    expect(bytesToBase64(ascii('fo'))).toBe('Zm8=');
    expect(bytesToBase64(ascii('foo'))).toBe('Zm9v');
    expect(bytesToBase64(ascii('foob'))).toBe('Zm9vYg==');
    expect(bytesToBase64(ascii('fooba'))).toBe('Zm9vYmE=');
    expect(bytesToBase64(ascii('foobar'))).toBe('Zm9vYmFy');
  });

  it('uses the standard alphabet, not the url-safe one', () => {
    // 0xfb 0xff → 111110 111111 1111(00) → 62 63 60 → '+/8='
    // URL-safe 编码器会给出 '-_8='，Rust 的 BASE64_STANDARD 解不开。
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]))).toBe('+/8=');
  });

  it('survives a payload larger than the chunk size', () => {
    // 40000 字节，刻意越过 0x8000 的分块边界。
    // 40000 = 3 × 13333 + 1 → 13333 个完整组 ('QUFB') 加一个单字节组 ('QQ==').
    const bytes = new Uint8Array(40000).fill(0x41);
    expect(bytesToBase64(bytes)).toBe('QUFB'.repeat(13333) + 'QQ==');
  });

  it('does not pad in the middle when a chunk ends mid-triple', () => {
    // 这条是上一条真正想守的东西：0x8000 = 32768，除以 3 余 2，
    // 所以分块边界一定落在某个三字节组中间。如果实现是「每块各自
    // btoa 再拼接」，中间会冒出 '=' 并把后面所有位错开 —— 长度看着
    // 没问题，内容全废。
    //
    // 总长取 0x8000 + 5 = 32773，除以 3 余 1，所以**末尾**恰好该有
    // 两个 '='。于是「唯一的 '=' 出现在倒数第二位」就是判据：
    // 中间多一个 '='，indexOf 就会往前跑。
    const size = 0x8000 + 5;
    const out = bytesToBase64(new Uint8Array(size).fill(0x41));
    expect(out.length).toBe(Math.ceil(size / 3) * 4);
    expect(out.endsWith('==')).toBe(true);
    expect(out.indexOf('=')).toBe(out.length - 2);
    expect(out.startsWith('QUFBQUFB')).toBe(true);
  });
});
