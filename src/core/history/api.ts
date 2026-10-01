/**
 * 历史记录的前端封装。
 *
 * 与 Rust 侧 `history.rs` 一一对应。
 */

import { invoke } from '@tauri-apps/api/core';
import type { ContentUnit } from '@/core/content/types';
import type { DesignSpec } from '@/core/design/spec';
import type { Protocol } from '@/core/llm/types';
import { toCommandError } from '@/core/llm/types';
import { isTauri } from '@/core/llm/api';

/** 一条历史记录。 */
export interface HistoryEntry {
  id: string;
  docType: 'resume' | 'cover-letter';
  createdAt: number;
  providerName: string;
  modelName: string;
  protocol: Protocol | string;
  designSpec: DesignSpec;
  /** 完整内容快照 —— 回滚全靠它。 */
  contentSnapshot: ContentUnit[];
  contentHash: string;
  note?: string;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw {
      kind: 'no_tauri',
      message: '当前不在 Tauri 应用内运行，无法访问历史记录。',
    };
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toCommandError(e);
  }
}

/** 列出全部记录（已按时间倒序）。 */
export const listHistory = (): Promise<HistoryEntry[]> => call('list_history');

/** 新增一条。返回因超出上限被丢弃的条数。 */
export const addHistory = (entry: HistoryEntry): Promise<number> =>
  call('add_history', { entry });

/** 取一条（回滚时用）。 */
export const getHistory = (id: string): Promise<HistoryEntry> =>
  call('get_history', { id });

export const deleteHistory = (id: string): Promise<void> =>
  call('delete_history', { id });

/** 批量删除。返回实际删除数量。 */
export const deleteHistoryMany = (ids: string[]): Promise<number> =>
  call('delete_history_many', { ids });

export const clearHistory = (): Promise<number> => call('clear_history');

/** 生成一条历史记录的 ID。 */
export function newHistoryId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 18);
  return `h_${rand}`;
}
