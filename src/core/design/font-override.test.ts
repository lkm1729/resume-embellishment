/**
 * 字体覆盖层（V0.1.2 第 2 条）。
 *
 * 这里测的不是"能不能换字体"，而是**换字体的代价被限制在哪里** ——
 * 覆盖刻意发生在 zod 校验之外，是整套设计里唯一一处破例，
 * 所以边界必须被钉死，免得以后有人顺手把它挪进 store。
 */

import { describe, expect, it } from 'vitest';
import type { ContentUnit } from '@/core/content/types';
import type { DesignSpec } from '@/core/design/spec';
import {
  DesignSpecSchema,
  NO_FONT_OVERRIDE,
  hasFontOverride,
  withFontOverride,
} from './spec';
import { renderDocument } from '@/core/render/render';

function unit(id: string, text: string): ContentUnit {
  return { id, kind: 'listItem', text, section: '技能' };
}

function specFor(units: readonly ContentUnit[]): DesignSpec {
  return {
    version: 1,
    layout: { template: 'single-column', sectionOrder: ['技能'], density: 'balanced' },
    theme: {
      palette: {
        primary: '#1f2937',
        accent: '#2563eb',
        text: '#111827',
        muted: '#6b7280',
        bg: '#ffffff',
      },
      fontPair: { heading: 'Cambria', body: 'Calibri' },
      scale: { h1: 1.6, h2: 1.15, body: 1, lineHeight: 1.4 },
      ruleStyle: 'thin',
      cornerRadius: 2,
    },
    sections: [{ section: '技能', style: { emphasis: 'normal' }, units: [{ contentId: units[0]!.id }] }],
  };
}

describe('hasFontOverride', () => {
  it('两个都是 null 才算没有覆盖', () => {
    expect(hasFontOverride(NO_FONT_OVERRIDE)).toBe(false);
    expect(hasFontOverride({ heading: 'KaiTi', body: null })).toBe(true);
    expect(hasFontOverride({ heading: null, body: 'KaiTi' })).toBe(true);
  });

  it('空白字符串等于没填', () => {
    // 类型允许传 `''` 进来，而空串在字体栈里会拼出一个空名字，
    // 让**整条** `font-family` 声明失效 —— 连后面的回退链一起丢。
    // 光在注释里约定"别传空串"不算数，必须在读的地方挡掉。
    expect(hasFontOverride({ heading: '', body: null })).toBe(false);
    expect(hasFontOverride({ heading: '   ', body: '\t' })).toBe(false);
    expect(hasFontOverride({ heading: '', body: 'KaiTi' })).toBe(true);
  });
});

describe('withFontOverride', () => {
  const units = [unit('u0001', '熟悉 React')];
  const spec = specFor(units);

  it('没有覆盖时返回**同一个对象**', () => {
    // 渲染路径上每次预览都会跑一遍这个函数。
    // 返回新对象会让下游所有 memo 失效、整篇文档重排一次。
    expect(withFontOverride(spec, NO_FONT_OVERRIDE)).toBe(spec);
  });

  it('只指定标题时，正文保持版式自带的那个', () => {
    const out = withFontOverride(spec, { heading: 'KaiTi', body: null });
    expect(out.theme.fontPair.heading).toBe('KaiTi');
    expect(out.theme.fontPair.body).toBe('Calibri');
  });

  it('用户选的正好等于版式自带的，也返回同一个对象', () => {
    const out = withFontOverride(spec, { heading: 'Cambria', body: 'Calibri' });
    expect(out).toBe(spec);
  });

  it('不改动源 spec', () => {
    withFontOverride(spec, { heading: 'KaiTi', body: 'SimSun' });
    expect(spec.theme.fontPair.heading).toBe('Cambria');
    expect(spec.theme.fontPair.body).toBe('Calibri');
  });

  it('白名单外的字体名能一路走到渲染结果里', () => {
    // 这是第 2 条的**验收点**：用户本机装了华文行楷，
    // 选了它，预览和导出里就必须真的是它。
    const out = withFontOverride(spec, { heading: '华文行楷', body: null });
    const html = renderDocument(units, out, { includeStyle: true });
    expect(html).toContain('"华文行楷"');
  });

  it('字体名里的结构性字符在拼进样式表之前被剥掉', () => {
    // 白名单时代把那行 `"${fontPair.heading}", …` 直接拼进 `<style>`
    // 毫无风险；现在族名是本机字体表里的自由字符串 ——
    // 里面出现 `"` 或 `</style>` 就能突破一条声明甚至整个样式块。
    const evil = 'Ev"il</style><script>';
    const out = withFontOverride(spec, { heading: evil, body: null });
    const html = renderDocument(units, out, { includeStyle: true });
    expect(html).not.toContain('</style><script>');
    expect(html).toContain('font-family: "Evil/stylescript", "Microsoft YaHei"');
  });

  it('名字被剥空时整段丢掉，退回默认字体栈', () => {
    // `font-family: "", "Microsoft YaHei"…` 会因为第一个名字非法而让
    // **整条**声明失效，连回退链一起丢 —— 那比只丢一个名字糟得多。
    const out = withFontOverride(spec, { heading: '""', body: null });
    const html = renderDocument(units, out, { includeStyle: true });
    expect(html).not.toContain('font-family: ""');
    expect(html).toContain('font-family: "Microsoft YaHei", "Noto Sans SC", sans-serif');
  });

  it('覆盖之后的 spec 刻意**不再**通过 Schema 校验', () => {
    // 这条断言看着别扭，但它记录的正是设计意图：
    // `DesignSpecSchema` 是给**模型输出**把关的闸门（挡住本机没装的字体，
    // 免得渲染栈静默回退成雅黑），而不是渲染对象的格式约束。
    // 用户的手工选择必须能越过它。
    //
    // 如果哪天有人把用户字体写进 store 里那份 spec 来"简化"这里，
    // 这条会红 —— 那时真正坏掉的是「继续调整」：
    // 带 `华文行楷` 的 spec 发给模型、回来再走一遍校验，
    // 整轮调整会直接失败，而报错完全看不出跟字体有关。
    expect(DesignSpecSchema.safeParse(spec).success).toBe(true);
    const out = withFontOverride(spec, { heading: '华文行楷', body: null });
    expect(DesignSpecSchema.safeParse(out).success).toBe(false);
  });
});
