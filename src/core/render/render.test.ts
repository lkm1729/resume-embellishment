import { describe, expect, it } from 'vitest';
import type { ContentUnit } from '@/core/content/types';
import type { DesignSpec } from '@/core/design/spec';
import { renderDocument, extractVisibleText } from './render';

/** 一个最小的合法 DesignSpec：只考渲染，不考设计。 */
function specFor(units: readonly ContentUnit[]): DesignSpec {
  const section = units[0]?.section ?? '基本信息';
  return {
    version: 1,
    layout: { template: 'single-column', sectionOrder: [section], density: 'balanced' },
    theme: {
      palette: {
        primary: '#1f2937',
        accent: '#2563eb',
        text: '#111827',
        muted: '#6b7280',
        bg: '#ffffff',
      },
      fontPair: { heading: 'Calibri', body: 'Calibri' },
      scale: { h1: 1.6, h2: 1.15, body: 1, lineHeight: 1.4 },
      ruleStyle: 'thin',
      cornerRadius: 2,
    },
    sections: [
      {
        section,
        style: { emphasis: 'normal' },
        units: units.map((u) => ({ contentId: u.id })),
      },
    ],
  };
}

function unit(id: string, kind: ContentUnit['kind'], text: string): ContentUnit {
  return { id, kind, text, section: '技能' };
}

describe('列表项的渲染', () => {
  const units = [unit('u0001', 'listItem', '熟悉 React')];
  const html = renderDocument(units, specFor(units), { includeStyle: true });

  it('列表项渲染成 li，正文不留项目符号', () => {
    expect(html).toContain('<li class="unit kind-listItem">熟悉 React</li>');
    expect(extractVisibleText(html)).not.toContain('•');
    expect(extractVisibleText(html)).not.toContain('- 熟悉 React');
  });

  it('压掉浏览器 UA 给 li 的圆盘 marker（预览里的「••」第二个点）', () => {
    // UA 样式表对 li 施 list-style-type: disc，且**不要求**它在 ul/ol 里，
    // 所以裸 <li> 照样画点，与下面自绘的 ::before 叠成两个点。
    const rule = /\.unit\.kind-listItem,[\s\S]*?\{([\s\S]*?)\}/.exec(html)?.[1] ?? '';
    expect(rule).toContain('list-style: none');
  });

  it('模型指定 as:"li" 的单元走同一条规则，也只有一个点', () => {
    // 段落单元被模型指定渲染成 li：类名是 kind-paragraph，但标签是 li。
    const p = [unit('u0001', 'paragraph', '被指定成 li 的段落')];
    const spec = specFor(p);
    const first = spec.sections[0];
    if (first) {
      first.units = [{ contentId: 'u0001', style: { as: 'li' } }];
    }
    const out = renderDocument(p, spec, { includeStyle: true });
    expect(out).toContain('<li class="unit kind-paragraph">');
    // li.unit 这条选择器必须存在，且同样压掉 UA marker。
    const rule = /li\.unit \{([\s\S]*?)\}/.exec(out)?.[1] ?? '';
    expect(rule).toContain('list-style: none');
  });

  it('每个列表项只有一个自绘的圆点', () => {
    // ::before 的圆点规则同时挂在两条选择器上，但一个单元只命中一条 —— 不会画两次。
    const dotRules = html.match(/\.unit\.kind-listItem::before,\s*\nli\.unit::before/g) ?? [];
    expect(dotRules).toHaveLength(1);
  });
});

describe('列表项的续行', () => {
  // Markdown 的列表项可以有多行，解析后 unit.text 里是一个 \n。
  // 直接塞进 HTML 会被折叠成空格 —— 用户写的是两行，看到一行。
  const units = [unit('u0001', 'listItem', '服务端研发\n负责订单系统重构')];
  const html = renderDocument(units, specFor(units), { includeStyle: true });

  it('续行渲染成 br，而不是被折叠掉', () => {
    expect(html).toContain('<li class="unit kind-listItem">服务端研发<br>负责订单系统重构</li>');
  });

  it('br 不增加可见字符，保真判据仍成立', () => {
    // 这是关键：br 在可见文本里必须还原成换行，
    // 否则"两行"会粘成"一行"，比对会把没发生的改动报成差异。
    expect(extractVisibleText(html)).toContain('服务端研发\n负责订单系统重构');
  });
});
