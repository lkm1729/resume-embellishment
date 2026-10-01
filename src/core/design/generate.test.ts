/**
 * 生成编排的回归测试。
 *
 * 两个重点：
 *   1. 失败文案去重（用户报的"同一句话印三遍"）；
 *   2. 带图请求时，错误里必须提醒"可能是模型不支持图片" ——
 *      端点报错往往只说"请求不合法"，用户想不到是图的问题。
 */

import { describe, expect, it } from 'vitest';
import type { ContentUnit } from '@/core/content/types';
import { emptyInput, type WorkbenchInput } from '@/core/content/reference';
import type { DesignSpec } from './spec';
import { generateDesignSpec, type ChatClient, type ChatRequest } from './generate';

const UNITS: ContentUnit[] = [
  { id: 'u0001', kind: 'heading', section: '基本信息', text: '张三' },
  { id: 'u0002', kind: 'listItem', section: '技能', text: '熟悉 React' },
];

/** 一个永远以同样的话失败的客户端 —— 复现用户那条报错的三次重复。 */
const API_KEY_MISSING =
  '这个供应商还没有配置 API Key。\n在「模型供应商」里填一次即可，密钥会存进 Windows 凭据管理器。';

function failingClient(seen?: ChatRequest[]): ChatClient {
  return {
    async chat(req) {
      seen?.push(req);
      throw new Error(API_KEY_MISSING);
    },
  };
}

function params(input: Partial<WorkbenchInput> = {}, extra: Record<string, unknown> = {}) {
  return {
    units: UNITS,
    sections: ['基本信息', '技能'],
    input: { ...emptyInput(), ...input },
    docType: 'resume' as const,
    ...extra,
  };
}

describe('失败说明的去重', () => {
  it('同一句调用失败只出现一次，并说明它在多次尝试中重复', async () => {
    const out = await generateDesignSpec(failingClient(), params());

    expect(out.ok).toBe(false);
    const error = out.error ?? '';

    // 关键断言：那句话在全文里只出现一次。
    const occurrences = error.split(API_KEY_MISSING).length - 1;
    expect(occurrences).toBe(1);

    expect(error).toContain('模型未能产出合法的设计方案。');
    expect(error).toContain('调用失败：');
    expect(error).toContain('重复出现');
    // 面向下一步的提示必须还在
    expect(error).toContain('请检查：API Key 是否有效');
  });

  it('不同原因不被误合并', async () => {
    let n = 0;
    const client: ChatClient = {
      async chat() {
        n++;
        throw new Error(`第 ${n} 种失败`);
      },
    };
    const out = await generateDesignSpec(client, params());
    const error = out.error ?? '';

    expect(out.attempts.length).toBeGreaterThan(1);
    // 每次的失败文本都不同 —— 不应该出现"重复出现"那句。
    expect(error).not.toContain('重复出现');
  });
});

describe('带图请求的失败提示', () => {
  const IMAGE_INPUT: Partial<WorkbenchInput> = {
    references: [
      {
        id: 'r_img',
        role: 'reference',
        source: {
          kind: 'image',
          fileName: '版式参考.png',
          mime: 'image/png',
          dataBase64: 'aGVsbG8=',
          size: 5,
        },
        text: '版式参考.png',
        addedAt: 0,
      },
    ],
  };

  it('带了图片时，调用失败会提醒可能是模型不支持图片', async () => {
    const out = await generateDesignSpec(failingClient(), params(IMAGE_INPUT));
    expect(out.error ?? '').toContain('不支持图片输入');
  });

  it('没带图片时，不会出现图片相关的提示', async () => {
    const out = await generateDesignSpec(failingClient(), params());
    expect(out.error ?? '').not.toContain('不支持图片');
  });

  it('图片随请求下发，走独立的多模态分段而不是拼进提示词', async () => {
    const seen: ChatRequest[] = [];
    await generateDesignSpec(failingClient(seen), params(IMAGE_INPUT));

    expect(seen.length).toBeGreaterThan(0);
    const first = seen[0];
    expect(first?.images).toHaveLength(1);
    expect(first?.images?.[0]?.mime).toBe('image/png');
    // base64 绝不能出现在提示词正文里 —— 那既烧 token 模型又看不见。
    expect(first?.user ?? '').not.toContain('aGVsbG8=');
  });

  it('空载荷的图片被跳过，不会拼出半个 data URL', async () => {    const seen: ChatRequest[] = [];
    await generateDesignSpec(
      failingClient(seen),
      params({
        references: [
          {
            id: 'r_img',
            role: 'reference',
            source: {
              kind: 'image',
              fileName: '空的.png',
              mime: 'image/png',
              dataBase64: '   ',
              size: 0,
            },
            text: '空的.png',
            addedAt: 0,
          },
        ],
      }),
    );

    expect(seen[0]?.images ?? []).toHaveLength(0);
  });
});

describe('继续调整', () => {
  const SPEC: DesignSpec = {
    version: 1,
    layout: { template: 'single-column', sectionOrder: ['技能'], density: 'balanced' },
    theme: {
      palette: {
        primary: '#111827',
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
    sections: [{ section: '技能', style: { emphasis: 'normal' }, units: [{ contentId: 'u0002' }] }],
  };

  it('调整请求里带上当前版式与用户原话', async () => {
    const seen: ChatRequest[] = [];
    await generateDesignSpec(
      failingClient(seen),
      params({}, { refine: { spec: SPEC, instruction: '标题再大一点' } }),
    );

    const prompt = seen[0]?.user ?? '';
    expect(prompt).toContain('继续调整（这不是重新设计）');
    expect(prompt).toContain('标题再大一点');
    // 当前值必须在场 —— 否则"再大一点"没有基准。
    expect(prompt).toContain('"density": "balanced"');
    // 原有约束段不能被替换掉：内容清单与板块清单在调整时同样必须成立。
    expect(prompt).toContain('## 内容单元清单');
    expect(prompt).toContain('u0002 [listItem] 技能｜熟悉 React');
    // 调整段是**接在**原提示词之后的，不是替换它。
    expect(prompt.indexOf('## 内容单元清单')).toBeLessThan(
      prompt.indexOf('继续调整（这不是重新设计）'),
    );
  });

  it('不传 refine 时，提示词里没有调整段', async () => {
    const seen: ChatRequest[] = [];
    await generateDesignSpec(failingClient(seen), params());
    expect(seen[0]?.user ?? '').not.toContain('继续调整');
  });
});
