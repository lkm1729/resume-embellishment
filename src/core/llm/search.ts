/**
 * 模型列表的搜索与筛选。
 *
 * 抽成纯函数是为了可测试 —— 模型列表动辄几百条，
 * 搜索行为（大小写、分词、排序）值得用测试固定下来。
 */

import type { ModelInfo } from './types';

/** 搜索匹配：按空白分词，所有词都需命中（AND 语义）。 */
export function matchesQuery(model: ModelInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;

  const haystack = `${model.id} ${model.ownedBy ?? ''}`.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  return terms.every((t) => haystack.includes(t));
}

export interface FilterOptions {
  query?: string;
  /** 只显示尚未添加的模型。 */
  excludeIds?: ReadonlySet<string>;
}

/** 过滤模型列表。 */
export function filterModels(
  models: readonly ModelInfo[],
  options: FilterOptions = {},
): ModelInfo[] {
  const { query = '', excludeIds } = options;
  return models.filter((m) => {
    if (excludeIds?.has(m.id)) return false;
    return matchesQuery(m, query);
  });
}

/**
 * 排序：前缀匹配优先，其次按字母序。
 *
 * 这样搜 "gpt" 时 `gpt-4o` 会排在 `azure-gpt-4` 前面，
 * 更符合"我想找的那个"的直觉。
 */
export function sortModels(models: readonly ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim().toLowerCase();
  return [...models].sort((a, b) => {
    if (q) {
      const ap = a.id.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.id.toLowerCase().startsWith(q) ? 0 : 1;
      if (ap !== bp) return ap - bp;
    }
    return a.id.localeCompare(b.id);
  });
}

/** 搜索 + 过滤 + 排序的组合操作。 */
export function searchModels(
  models: readonly ModelInfo[],
  options: FilterOptions = {},
): ModelInfo[] {
  const filtered = filterModels(models, options);
  return sortModels(filtered, options.query ?? '');
}

/**
 * 按供应商前缀给模型分组，便于在长列表里快速定位。
 *
 * 例：`gpt-4o` → `gpt`；`claude-3-opus` → `claude`；
 * 无连字符的归入 `其他`。
 */
export function groupByPrefix(models: readonly ModelInfo[]): Map<string, ModelInfo[]> {
  const groups = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const idx = m.id.indexOf('-');
    const key = idx > 0 ? m.id.slice(0, idx).toLowerCase() : '其他';
    const bucket = groups.get(key);
    if (bucket) bucket.push(m);
    else groups.set(key, [m]);
  }
  return groups;
}
