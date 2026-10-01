/**
 * 供应商状态管理。
 *
 * 安全约定：**密钥绝不进入本 store**。
 * 组件里输入的 API Key 只作为参数直接传给后端命令，
 * 不写入状态、不持久化、不进日志。
 */

import { create } from 'zustand';
import * as api from './api';
import type { ModelInfo, Provider } from './types';
import { toCommandError } from './types';

interface ProviderState {
  providers: Provider[];
  loading: boolean;
  /** 最近一次操作的错误（中文，可直接展示）。 */
  error: string | null;
  /** 密钥环不可用时的提示；为 null 表示可用。 */
  keyringError: string | null;

  /** 已拉取但尚未保存到供应商的候选模型（按供应商 id 索引）。 */
  candidateModels: Record<string, ModelInfo[]>;
  /** 正在拉取模型列表的供应商 id。 */
  fetchingModels: Record<string, boolean>;
  /** 正在测试连通性的供应商 id。 */
  probing: Record<string, boolean>;

  load: () => Promise<void>;
  checkKeyring: () => Promise<void>;
  save: (provider: Provider, apiKey?: string) => Promise<Provider>;
  remove: (id: string) => Promise<void>;
  removeMany: (ids: string[]) => Promise<number>;
  hasKey: (id: string) => Promise<boolean>;

  loadModels: (id: string, apiKey?: string) => Promise<ModelInfo[]>;
  setCandidateModels: (id: string, models: ModelInfo[]) => void;
  clearCandidates: (id: string) => void;

  probe: (id: string, modelId: string, apiKey?: string) => Promise<void>;

  clearError: () => void;
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  providers: [],
  loading: false,
  error: null,
  keyringError: null,
  candidateModels: {},
  fetchingModels: {},
  probing: {},

  async checkKeyring() {
    try {
      await api.keyringStatus();
      set({ keyringError: null });
    } catch (e) {
      const err = toCommandError(e);
      set({
        keyringError:
          err.kind === 'keyring_unavailable'
            ? `${err.message}\n\nAPI Key 将无法保存。请检查系统凭据管理器是否可用。`
            : err.message,
      });
    }
  },

  async load() {
    set({ loading: true, error: null });
    try {
      const providers = await api.listProviders();
      set({ providers, loading: false });
    } catch (e) {
      set({ error: toCommandError(e).message, loading: false });
    }
  },

  async save(provider, apiKey) {
    set({ error: null });
    try {
      const saved = await api.saveProvider(provider, apiKey);
      const list = get().providers;
      const idx = list.findIndex((p) => p.id === saved.id);
      const next = idx >= 0
        ? list.map((p) => (p.id === saved.id ? saved : p))
        : [...list, saved];
      set({ providers: next });
      return saved;
    } catch (e) {
      const err = toCommandError(e);
      set({ error: err.message });
      throw err;
    }
  },

  async remove(id) {
    set({ error: null });
    try {
      await api.deleteProvider(id);
      set({
        providers: get().providers.filter((p) => p.id !== id),
        candidateModels: Object.fromEntries(
          Object.entries(get().candidateModels).filter(([k]) => k !== id),
        ),
      });
    } catch (e) {
      const err = toCommandError(e);
      set({ error: err.message });
      throw err;
    }
  },

  async removeMany(ids) {
    set({ error: null });
    try {
      const n = await api.deleteProviders(ids);
      const setIds = new Set(ids);
      set({ providers: get().providers.filter((p) => !setIds.has(p.id)) });
      return n;
    } catch (e) {
      const err = toCommandError(e);
      set({ error: err.message });
      throw err;
    }
  },

  async hasKey(id) {
    try {
      return await api.providerHasKey(id);
    } catch {
      return false;
    }
  },

  async loadModels(id, apiKey) {
    set({
      error: null,
      fetchingModels: { ...get().fetchingModels, [id]: true },
    });
    try {
      const models = await api.fetchModels(id, apiKey);
      set({
        candidateModels: { ...get().candidateModels, [id]: models },
        fetchingModels: { ...get().fetchingModels, [id]: false },
      });
      return models;
    } catch (e) {
      const err = toCommandError(e);
      set({
        error: err.message,
        fetchingModels: { ...get().fetchingModels, [id]: false },
      });
      throw err;
    }
  },

  setCandidateModels(id, models) {
    set({ candidateModels: { ...get().candidateModels, [id]: models } });
  },

  clearCandidates(id) {
    const next = { ...get().candidateModels };
    delete next[id];
    set({ candidateModels: next });
  },

  async probe(id, modelId, apiKey) {
    set({ error: null, probing: { ...get().probing, [id]: true } });
    try {
      const result = await api.testProvider(id, modelId, apiKey);
      // 后端已把结果写回配置，这里同步本地副本
      set({
        providers: get().providers.map((p) =>
          p.id === id ? { ...p, lastProbe: result } : p,
        ),
        probing: { ...get().probing, [id]: false },
      });
    } catch (e) {
      const err = toCommandError(e);
      set({ error: err.message, probing: { ...get().probing, [id]: false } });
      throw err;
    }
  },

  clearError() {
    set({ error: null });
  },
}));
