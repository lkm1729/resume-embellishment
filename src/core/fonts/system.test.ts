/**
 * 本机字体目录（V0.1.2 第 2 条）。
 *
 * 重点是**中文字体的名字对不上**这件事：Windows 枚举给的是
 * `微软雅黑`，而设计规范的白名单里写的是 `Microsoft YaHei`。
 * 少了对照，推荐区里那一条会凭空消失，然后以另一个名字混进
 * 底下两百多个字体里 —— 看起来就像推荐列表坏了。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FONT_WHITELIST } from '@/core/design/spec';
import { filterFonts, loadFontCatalog, resetFontCatalog } from './system';

// `vi.mock` 会被提升到 import 之前，所以这里保持顶层 import 的写法即可。
const listSystemFonts = vi.hoisted(() => vi.fn<() => Promise<string[]>>());

vi.mock('@/core/llm/api', () => ({ listSystemFonts }));

afterEach(() => {
  resetFontCatalog();
  listSystemFonts.mockReset();
});

describe('loadFontCatalog', () => {
  it('中文字体按本地化名认出来，但 value 仍用白名单里的写法', async () => {
    listSystemFonts.mockResolvedValue(['Arial', '微软雅黑', '华文行楷']);
    const catalog = await loadFontCatalog();

    const yahei = catalog.recommended.find((o) => o.value === 'Microsoft YaHei');
    expect(yahei?.label).toBe('微软雅黑');
    // value 必须是模型也会产出的那个写法：用户不覆盖时，
    // 两条路径得到完全一样的字体名，行为不会因写法不同而变样。
    expect(yahei?.value).toBe('Microsoft YaHei');
  });

  it('被推荐区认领过的系统名不会在「其他」里重复出现', async () => {
    listSystemFonts.mockResolvedValue(['Arial', '微软雅黑', '华文行楷']);
    const catalog = await loadFontCatalog();

    expect(catalog.others.map((o) => o.value)).toEqual(['华文行楷']);
    expect(catalog.recommended.map((o) => o.value)).toContain('Arial');
  });

  it('读不到系统字体时回落到内置白名单，并如实标记', async () => {
    listSystemFonts.mockRejectedValue(new Error('拿不到设备上下文'));
    const catalog = await loadFontCatalog();

    expect(catalog.fromSystem).toBe(false);
    expect(catalog.others).toEqual([]);
    expect(catalog.recommended).toHaveLength(FONT_WHITELIST.length);
    // 错误**不吞掉**：界面要拿它说明为什么列表这么短，
    // 否则用户会以为"我明明装了那个字体"。
    expect(catalog.error).toBe('拿不到设备上下文');
  });

  it('只问后端一次', async () => {
    listSystemFonts.mockResolvedValue(['Arial']);
    await loadFontCatalog();
    await loadFontCatalog();
    expect(listSystemFonts).toHaveBeenCalledTimes(1);
  });
});

describe('filterFonts', () => {
  const options = [
    { value: 'Microsoft YaHei', label: '微软雅黑', aliases: ['Microsoft YaHei'] },
    { value: '华文行楷', label: '华文行楷', aliases: [] },
  ];

  it('空关键词返回全部', () => {
    expect(filterFonts(options, '   ')).toHaveLength(2);
  });

  it('中文名和英文名搜到同一个字体', () => {
    // 用户可能记得「微软雅黑」，也可能记得 Microsoft YaHei。
    expect(filterFonts(options, '雅黑')).toHaveLength(1);
    expect(filterFonts(options, 'yahei')).toHaveLength(1);
  });

  it('大小写不敏感', () => {
    expect(filterFonts(options, 'YAHEI')).toHaveLength(1);
  });

  it('没有匹配时返回空数组而不是全部', () => {
    expect(filterFonts(options, 'zzz')).toEqual([]);
  });
});
