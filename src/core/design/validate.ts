import type { ContentUnit } from '@/core/content/types';
import { DesignSpecSchema, collectReferencedIds, type DesignSpec } from './spec';

/**
 * DesignSpec 校验 —— 在 zod 结构校验之上，施加**语义层**约束。
 *
 * zod 保证「形状对」，本模块保证「内容对」：
 *   1. 每个内容单元都被引用（不能漏渲染导致内容静默丢失）
 *   2. 没有幻觉 ID（模型不能凭空引用不存在的单元）
 *   3. sectionOrder 只包含真实存在的板块
 *   4. 不重复引用同一单元（防重复渲染同一段文字）
 */

export interface SpecValidationIssue {
  readonly kind:
    | 'schema'
    | 'unreferenced'
    | 'unknown-id'
    | 'duplicate-ref'
    | 'unknown-section'
    | 'empty';
  readonly message: string;
  /** 相关的单元 ID 或板块名。 */
  readonly ref?: string;
}

export interface SpecValidationResult {
  readonly ok: boolean;
  readonly issues: readonly SpecValidationIssue[];
  /** 解析成功时的 spec。 */
  readonly spec?: DesignSpec;
}

/**
 * 校验 LLM 返回的 DesignSpec。
 *
 * @param raw      模型返回的原始对象（已 JSON.parse）
 * @param units    冻结的内容单元
 * @param sections 原文中实际存在的板块名
 */
export function validateSpec(
  raw: unknown,
  units: readonly ContentUnit[],
  sections: readonly string[],
): SpecValidationResult {
  const issues: SpecValidationIssue[] = [];

  const parsed = DesignSpecSchema.safeParse(raw);
  if (!parsed.success) {
    for (const err of parsed.error.issues) {
      issues.push({
        kind: 'schema',
        message: `${err.path.join('.') || '(root)'}: ${err.message}`,
      });
    }
    return { ok: false, issues };
  }

  const spec = parsed.data;
  const knownIds = new Set(units.map((u) => u.id));
  const referencedIds = collectReferencedIds(spec);

  // 1. 幻觉 ID
  for (const id of referencedIds) {
    if (!knownIds.has(id)) {
      issues.push({ kind: 'unknown-id', message: `引用了不存在的内容单元 ${id}`, ref: id });
    }
  }

  // 2. 漏引用 —— 最危险的失败模式
  const referenced = new Set(referencedIds);
  for (const unit of units) {
    if (!referenced.has(unit.id)) {
      issues.push({
        kind: 'unreferenced',
        message: `内容单元 ${unit.id} 未被引用，会导致内容丢失`,
        ref: unit.id,
      });
    }
  }

  // 3. 重复引用
  const seen = new Set<string>();
  for (const id of referencedIds) {
    if (seen.has(id)) {
      issues.push({ kind: 'duplicate-ref', message: `内容单元 ${id} 被重复引用`, ref: id });
    }
    seen.add(id);
  }

  // 4. 未知板块名
  const knownSections = new Set(sections);
  for (const s of spec.layout.sectionOrder) {
    if (!knownSections.has(s)) {
      issues.push({ kind: 'unknown-section', message: `sectionOrder 含未知板块「${s}」`, ref: s });
    }
  }
  for (const s of spec.sections) {
    if (!knownSections.has(s.section)) {
      issues.push({ kind: 'unknown-section', message: `sections 含未知板块「${s.section}」`, ref: s.section });
    }
  }

  // 5. 空输出
  if (spec.sections.every((s) => s.units.length === 0)) {
    issues.push({ kind: 'empty', message: '所有板块均为空，未引用任何内容' });
  }

  return { ok: issues.length === 0, issues, spec };
}

/**
 * 把校验错误整理成可回灌给模型的修复提示。
 *
 * 这是结构化输出回退链第 4 层「修复轮」的输入 ——
 * 与其让模型重来，不如把具体错在哪告诉它，命中率显著更高。
 */
export function formatIssuesForRetry(issues: readonly SpecValidationIssue[]): string {
  const lines = issues.map((i) => `- [${i.kind}] ${i.message}`);
  return [
    '你上一次的输出存在以下问题，请修正后重新输出完整的 JSON：',
    ...lines,
    '',
    '注意：你只能引用已有内容单元的 ID，不得新增或改写任何正文。',
  ].join('\n');
}
