/**
 * 历史记录状态。
 *
 * ═══════════════════════════════════════════════════════════════
 *  回滚的语义需要说清楚，因为有两种截然不同的意图：
 *
 *   1. **完全恢复** —— 连正文一起回到当时的样子。
 *      适用于"我改坏了，退回去"。
 *   2. **仅套用样式** —— 保留现在正在编辑的正文，只把版式换掉。
 *      适用于"我又加了一段经历，想沿用上次那个好看的版式"。
 *
 *  如果只提供第 1 种，用户在改了正文之后就不敢回滚了 ——
 *  一回滚新写的字就没了。而第 2 种恰恰是高频需求。
 *
 *  因此回滚时**必须让用户选**，并在正文与快照不一致时明确提示。
 * ═══════════════════════════════════════════════════════════════
 */

import { create } from 'zustand';
import * as api from './api';
import type { HistoryEntry } from './api';
import type { ContentUnit } from '@/core/content/types';
import type { DocType } from '@/core/store/workbench';
import { useWorkbenchStore } from '@/core/store/workbench';
import { useGenerationStore } from '@/core/store/generation';
import { toCommandError } from '@/core/llm/types';

/** 回滚方式。 */
export type RollbackMode =
  /** 内容 + 样式都回到快照。 */
  | 'full'
  /** 只套用样式，保留当前正文。 */
  | 'style-only';

/**
 * 深拷贝内容快照。
 *
 * ⚠ 必须深拷贝，不能只复制数组。
 *
 * `[...units]` 只复制了数组外壳，单元对象仍是同一个引用 ——
 * 一旦将来有代码就地修改了某个单元（例如给 meta 补字段），
 * 历史记录里的"当时的样子"会跟着变。
 *
 * 而历史记录的全部价值就在于**它是过去的快照**。
 * 这个不变式值得用一次深拷贝来钉死：单元是小块纯数据，代价可忽略。
 */
function snapshotUnits(units: readonly ContentUnit[]): ContentUnit[] {
  if (typeof structuredClone === 'function') {
    return structuredClone(units) as ContentUnit[];
  }
  // 兜底：单元是可序列化的纯数据（见 types.ts 的约束）
  return JSON.parse(JSON.stringify(units)) as ContentUnit[];
}

interface HistoryState {
  entries: HistoryEntry[];
  loading: boolean;
  error: string | null;
  /** 已勾选的记录 id（多选删除用）。 */
  selected: Set<string>;
  /** 正在回滚的记录 id。 */
  rollingBack: string | null;

  load: () => Promise<void>;
  save: (entry: HistoryEntry) => Promise<void>;
  remove: (id: string) => Promise<void>;
  removeMany: (ids: string[]) => Promise<number>;
  clearAll: () => Promise<number>;

  toggleSelect: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clearSelection: () => void;

  /**
   * 回滚到某条记录。
   *
   * @param mode 'full' 连正文一起恢复；'style-only' 只套样式
   */
  rollback: (id: string, mode: RollbackMode) => Promise<void>;

  clearError: () => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  entries: [],
  loading: false,
  error: null,
  selected: new Set(),
  rollingBack: null,

  async load() {
    set({ loading: true, error: null });
    try {
      const entries = await api.listHistory();
      set({ entries, loading: false });
    } catch (e) {
      set({ error: toCommandError(e).message, loading: false });
    }
  },

  async save(entry) {
    set({ error: null });
    try {
      // 在这里统一深拷贝，而不是指望每个调用方记得做 ——
      // 快照的独立性是这个模块的核心不变式
      await api.addHistory({
        ...entry,
        contentSnapshot: snapshotUnits(entry.contentSnapshot),
      });
      // 重新拉取而不是本地插入：排序与上限裁剪都由后端决定，
      // 本地插入会与后端产生不一致
      const entries = await api.listHistory();
      set({ entries });
    } catch (e) {
      const err = toCommandError(e);
      set({ error: err.message });
      throw err;
    }
  },

  async remove(id) {
    set({ error: null });
    try {
      await api.deleteHistory(id);
      const selected = new Set(get().selected);
      selected.delete(id);
      set({ entries: get().entries.filter((e) => e.id !== id), selected });
    } catch (e) {
      const err = toCommandError(e);
      set({ error: err.message });
      throw err;
    }
  },

  async removeMany(ids) {
    set({ error: null });
    try {
      const n = await api.deleteHistoryMany(ids);
      const drop = new Set(ids);
      set({
        entries: get().entries.filter((e) => !drop.has(e.id)),
        selected: new Set(),
      });
      return n;
    } catch (e) {
      const err = toCommandError(e);
      set({ error: err.message });
      throw err;
    }
  },

  async clearAll() {
    set({ error: null });
    try {
      const n = await api.clearHistory();
      set({ entries: [], selected: new Set() });
      return n;
    } catch (e) {
      const err = toCommandError(e);
      set({ error: err.message });
      throw err;
    }
  },

  toggleSelect(id) {
    const next = new Set(get().selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ selected: next });
  },

  selectAll(ids) {
    set({ selected: new Set(ids) });
  },

  clearSelection() {
    set({ selected: new Set() });
  },

  async rollback(id, mode) {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry) {
      set({ error: `找不到历史记录 ${id}` });
      return;
    }

    set({ rollingBack: id, error: null });
    try {
      const wb = useWorkbenchStore.getState();
      const gen = useGenerationStore.getState();
      const type: DocType = entry.docType;

      if (mode === 'full') {
        // 恢复正文：把快照的单元文本重新拼回文本域。
        //
        // 注意这里恢复的是**原文**，不是渲染结果 ——
        // 快照里存的是 ContentUnit（含原文 text），
        // 因此拼回去的就是用户当时写的东西。
        const text = entry.contentSnapshot.map((u) => u.text).join('\n');
        wb.setMainText(type, text);
        await wb.reparse(type);
      }

      // 套用设计参数。两种模式都要做这件事。
      gen.applySpec(type, entry.designSpec, {
        providerId: '',
        providerName: entry.providerName,
        modelId: entry.modelName,
        modelName: entry.modelName,
        protocol: entry.protocol as never,
        at: entry.createdAt,
      });

      set({ rollingBack: null });
    } catch (e) {
      set({ rollingBack: null, error: toCommandError(e).message });
    }
  },

  clearError() {
    set({ error: null });
  },
}));

/**
 * 判断当前编辑器的正文是否与某条历史记录一致。
 *
 * 用于回滚前提示："你现在的正文和这条记录不一样，
 * 完全恢复会覆盖当前的改动。"
 *
 * 比对用 contentHash（解析时已算好），不做文本 diff ——
 * 哈希不等就足以支撑"要不要覆盖"这个决定，
 * 而给出逐字差异反而会让用户陷入细节。
 */
export function contentMatches(
  entry: HistoryEntry,
  currentHash: string | undefined,
): boolean {
  if (!currentHash) return false;
  return entry.contentHash === currentHash;
}
