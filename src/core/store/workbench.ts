/**
 * 工作台状态（方块 1–5 + 风格选择）。
 *
 * 两个板块（简历 / 求职信）各持有一份独立输入。
 * 为什么不做成"当前板块"的单一状态：
 * 用户经常在两块之间来回对照着写，清空另一块会让人措手不及。
 *
 * 关键的**归属路由**：方块 4/5 导入的参考资料可以标注归属，
 * 只有归到 `primary` 的才会变成 ContentUnit 进入成品；
 * 其余（岗位 / 补充 / 设计参考）只作为设计决策的输入。
 * 这个区分是保真需求的核心 —— 用户导入别人的简历当参考时，
 * 那些文字绝不能被渲染进自己的成品。
 */

import { create } from 'zustand';
import type { RefRole, Reference, TextMode, WorkbenchInput } from '@/core/content/reference';
import { emptyInput } from '@/core/content/reference';
import type { ParsedDocument } from '@/core/content/types';
import { parseDocument } from '@/core/content/parse';
import { profileFor } from '@/core/design/presets';

/** 板块标识。 */
export type DocType = 'resume' | 'cover-letter';

interface WorkbenchState {
  /** 两个板块各自的输入。 */
  inputs: Record<DocType, WorkbenchInput>;
  /** 上一次解析结果（按板块）。派生数据，随输入变化重算。 */
  parsed: Record<DocType, ParsedDocument | null>;
  /** 上次成功解析的时间戳，用于界面展示。 */
  parsedAt: Record<DocType, number | null>;
  /** 解析进行中的标志（解析是异步的，因为要算 SHA-256）。 */
  parsing: Record<DocType, boolean>;
  /** 解析失败信息。 */
  parseError: Record<DocType, string | null>;

  setMainText: (type: DocType, text: string) => void;
  setMainMode: (type: DocType, mode: TextMode) => void;
  setTargetRole: (type: DocType, text: string) => void;
  setExtraNotes: (type: DocType, text: string) => void;
  setCustomStyle: (type: DocType, text: string) => void;
  setPreset: (type: DocType, presetId: string | null) => void;

  addReference: (type: DocType, ref: Reference) => void;
  updateReference: (type: DocType, id: string, patch: Partial<Reference>) => void;
  removeReference: (type: DocType, id: string) => void;
  removeReferences: (type: DocType, ids: string[]) => void;
  clearReferences: (type: DocType) => void;

  /** 重新解析某一板块的正文。文本或模式变化后调用。 */
  reparse: (type: DocType) => Promise<void>;
  /** 清空某一板块的全部输入。 */
  reset: (type: DocType) => void;
}

/** 生成参考资料 ID。 */
export function newReferenceId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `r_${rand}`;
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  inputs: {
    resume: emptyInput(),
    'cover-letter': emptyInput(),
  },
  parsed: { resume: null, 'cover-letter': null },
  parsedAt: { resume: null, 'cover-letter': null },
  parsing: { resume: false, 'cover-letter': false },
  parseError: { resume: null, 'cover-letter': null },

  setMainText(type, text) {
    set({
      inputs: { ...get().inputs, [type]: { ...get().inputs[type], mainText: text } },
    });
  },

  setMainMode(type, mode) {
    set({
      inputs: { ...get().inputs, [type]: { ...get().inputs[type], mainMode: mode } },
    });
  },

  setTargetRole(type, text) {
    set({
      inputs: { ...get().inputs, [type]: { ...get().inputs[type], targetRole: text } },
    });
  },

  setExtraNotes(type, text) {
    set({
      inputs: { ...get().inputs, [type]: { ...get().inputs[type], extraNotes: text } },
    });
  },

  setCustomStyle(type, text) {
    set({
      inputs: { ...get().inputs, [type]: { ...get().inputs[type], customStyle: text } },
    });
  },

  setPreset(type, presetId) {
    const defaults = profileFor(type, presetId);
    const current = get().inputs[type];
    set({
      inputs: {
        ...get().inputs,
        [type]: {
          ...current,
          presetId,
          // 预设也带自定义说明时，把它填进输入框作为起点，用户可继续编辑。
          // 留空的预设不覆盖用户已经写好的自定义要求。
          customStyle: defaults ?? current.customStyle,
        },
      },
    });
  },

  addReference(type, ref) {
    const current = get().inputs[type];
    set({
      inputs: {
        ...get().inputs,
        [type]: { ...current, references: [...current.references, ref] },
      },
    });
  },

  updateReference(type, id, patch) {
    const current = get().inputs[type];
    set({
      inputs: {
        ...get().inputs,
        [type]: {
          ...current,
          references: current.references.map((r) =>
            r.id === id ? { ...r, ...patch } : r,
          ),
        },
      },
    });
  },

  removeReference(type, id) {
    const current = get().inputs[type];
    set({
      inputs: {
        ...get().inputs,
        [type]: {
          ...current,
          references: current.references.filter((r) => r.id !== id),
        },
      },
    });
  },

  removeReferences(type, ids) {
    const drop = new Set(ids);
    const current = get().inputs[type];
    set({
      inputs: {
        ...get().inputs,
        [type]: {
          ...current,
          references: current.references.filter((r) => !drop.has(r.id)),
        },
      },
    });
  },

  clearReferences(type) {
    const current = get().inputs[type];
    set({ inputs: { ...get().inputs, [type]: { ...current, references: [] } } });
  },

  async reparse(type) {
    const { mainText, mainMode } = get().inputs[type];

    if (mainText.trim().length === 0) {
      set({
        parsed: { ...get().parsed, [type]: null },
        parsedAt: { ...get().parsedAt, [type]: null },
        parseError: { ...get().parseError, [type]: null },
      });
      return;
    }

    set({ parsing: { ...get().parsing, [type]: true } });
    try {
      const doc = await parseDocument(mainText, mainMode);
      set({
        parsed: { ...get().parsed, [type]: doc },
        parsedAt: { ...get().parsedAt, [type]: Date.now() },
        parsing: { ...get().parsing, [type]: false },
        parseError: { ...get().parseError, [type]: null },
      });
    } catch (e) {
      set({
        parsing: { ...get().parsing, [type]: false },
        parseError: {
          ...get().parseError,
          [type]: e instanceof Error ? e.message : String(e),
        },
      });
    }
  },

  reset(type) {
    set({
      inputs: { ...get().inputs, [type]: emptyInput() },
      parsed: { ...get().parsed, [type]: null },
      parsedAt: { ...get().parsedAt, [type]: null },
      parseError: { ...get().parseError, [type]: null },
    });
  },
}));

/** 该板块中会进入成品的参考资料（只有 primary 归属的）。 */
export function primaryReferences(input: WorkbenchInput): Reference[] {
  return input.references.filter((r) => r.role === 'primary');
}

/** 按归属分组，便于 UI 展示"哪些会进成品"。 */
export function groupReferencesByRole(
  input: WorkbenchInput,
): Array<{ role: RefRole; refs: Reference[] }> {
  const order: RefRole[] = ['primary', 'target', 'extra', 'reference'];
  return order
    .map((role) => ({ role, refs: input.references.filter((r) => r.role === role) }))
    .filter((g) => g.refs.length > 0);
}
