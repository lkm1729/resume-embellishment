import { describe, expect, it } from 'vitest';
import { parseDocument } from './parse';

/** 只取「正文长什么样」，忽略 id 与板块归属 —— 这里考的是保真契约。 */
async function bodies(source: string): Promise<Array<[string, string, number | null]>> {
  const doc = await parseDocument(source, 'markdown');
  return doc.units.map((u) => [u.kind, u.text, u.level ?? null]);
}

describe('Markdown 列表项解析', () => {
  it('紧凑多行项保留续行（曾整段丢弃）', async () => {
    const units = await bodies('- 服务端研发\n  负责订单系统重构\n- 单行项');
    expect(units).toEqual([
      ['listItem', '服务端研发\n负责订单系统重构', null],
      ['listItem', '单行项', null],
    ]);
  });

  it('嵌套子列表各自成单元，且不在父项正文里重复出现', async () => {
    const units = await bodies('- 熟悉 TypeScript\n  - 嵌套项');
    expect(units).toEqual([
      ['listItem', '熟悉 TypeScript', null],
      ['listItem', '嵌套项', 1],
    ]);
  });

  it('松散项的续行与嵌套都完整保留，且不重复', async () => {
    const units = await bodies('- 甲\n  续行\n\n  - 嵌套\n- 乙');
    expect(units).toEqual([
      ['listItem', '甲\n续行', null],
      ['listItem', '嵌套', 1],
      ['listItem', '乙', null],
    ]);
  });

  it('松散项的两个段落合成正文，两段都不丢', async () => {
    const units = await bodies('- 第一段\n\n  第二段\n- 下一项');
    expect(units).toEqual([
      ['listItem', '第一段\n第二段', null],
      ['listItem', '下一项', null],
    ]);
  });

  it('有序列表剥掉序号', async () => {
    const units = await bodies('1. 第一\n2. 第二');
    expect(units).toEqual([
      ['listItem', '第一', null],
      ['listItem', '第二', null],
    ]);
  });

  it('任务列表剥掉方框，只留正文', async () => {
    const units = await bodies('- [ ] 待办');
    expect(units).toEqual([['listItem', '待办', null]]);
  });

  it('行内语法保留给渲染层', async () => {
    const units = await bodies('- **粗体**开头');
    expect(units).toEqual([['listItem', '**粗体**开头', null]]);
  });

  it('项目符号本身不再出现在正文里', async () => {
    const units = await bodies('- 熟悉 React\n- 熟悉 TypeScript');
    const texts = units.map((u) => u[1]);
    expect(texts).toEqual(['熟悉 React', '熟悉 TypeScript']);
    for (const t of texts) {
      expect(t.startsWith('-')).toBe(false);
      expect(t.startsWith('•')).toBe(false);
    }
  });
});
