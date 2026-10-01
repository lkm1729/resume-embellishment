/**
 * 供应商编辑表单。
 *
 * 覆盖需求里的核心机制：
 *   - 自定义 Base URL / 名称
 *   - 两种协议（Chat Completions / Responses）
 *   - 一键拉取模型列表，可搜索、多选、全选
 *   - 自定义模型 ID 与显示名
 *   - 测试模型连通性
 *
 * API Key 处理原则：输入后只作为参数直接传给后端命令，
 * 不进入任何持久化状态；留空表示"沿用已保存的密钥"。
 */

import { useState } from 'react';
import { ArrowLeft, Download, Loader2, Plus, SlidersHorizontal, Trash2, Zap } from 'lucide-react';
import { useProviderStore } from '@/core/llm/store';
import type { ModelEntry, ModelInfo, Protocol, Provider } from '@/core/llm/types';
import { PROTOCOL_HINTS, PROTOCOL_LABELS } from '@/core/llm/types';
import { settingsSummary } from '@/core/llm/model-settings';
import { AuraPanel, OrbitSpinner } from '@/components/effects';
import { ModelPicker } from './ModelPicker';
import { ModelSettingsPanel } from './ModelSettingsPanel';

interface Props {
  initial: Provider;
  onDone: () => void;
  onCancel: () => void;
}

export function ProviderForm({ initial, onDone, onCancel }: Props) {
  const save = useProviderStore((s) => s.save);
  const loadModels = useProviderStore((s) => s.loadModels);
  const probe = useProviderStore((s) => s.probe);
  const candidateModels = useProviderStore((s) => s.candidateModels);
  const fetching = useProviderStore((s) => s.fetchingModels);
  const probing = useProviderStore((s) => s.probing);

  const [name, setName] = useState(initial.name);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [protocol, setProtocol] = useState<Protocol>(initial.protocol);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ModelEntry[]>(initial.models);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSelection, setPickerSelection] = useState<Set<string>>(new Set());
  const [showKey, setShowKey] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testModel, setTestModel] = useState<string>(initial.models[0]?.id ?? '');
  const [saving, setSaving] = useState(false);
  /**
   * 哪一个模型展开了自定义参数面板。
   *
   * 按**下标**记而不是按模型 id：手动新增的行 id 一开始是空串，
   * 空串之间无法区分。代价是删行/批量添加后下标会错位，
   * 所以在那两处直接把面板收起来（见 removeModel 与 applyPickerSelection）——
   * 列表结构变了还留着「第 3 行展开着」反而更容易让人改错对象。
   */
  const [expanded, setExpanded] = useState<number | null>(null);

  const isNew = !initial.name;
  const candidates: ModelInfo[] = candidateModels[initial.id] ?? [];
  const isFetching = !!fetching[initial.id];
  const isProbing = !!probing[initial.id];
  const probeResult = useProviderStore((s) =>
    s.providers.find((p) => p.id === initial.id)?.lastProbe,
  );

  /** 先保存配置（含密钥），再拉模型列表 —— 后端拉取时需要已存好的密钥。 */
  const handleFetchModels = async () => {
    setLocalError(null);
    setNotice(null);
    try {
      // 若已填新密钥，先落盘；否则沿用已保存的
      await save(
        { ...initial, name, baseUrl, protocol, models },
        apiKey.trim() || undefined,
      );
      const list = await loadModels(initial.id, apiKey.trim() || undefined);
      setPickerSelection(new Set());
      setPickerOpen(true);
      setNotice(`已取到 ${list.length} 个模型`);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String((e as { message?: string }).message ?? e));
    }
  };

  const handleTest = async () => {
    setLocalError(null);
    setNotice(null);
    const target = testModel.trim() || models[0]?.id;
    if (!target) {
      setLocalError('请先添加或选择一个模型再测试');
      return;
    }
    try {
      await save(
        { ...initial, name, baseUrl, protocol, models },
        apiKey.trim() || undefined,
      );
      await probe(initial.id, target, apiKey.trim() || undefined);
      setNotice(`已测试模型 ${target}`);
    } catch (e) {
      setLocalError(String((e as { message?: string }).message ?? e));
    }
  };

  const applyPickerSelection = () => {
    const existing = new Set(models.map((m) => m.id));
    const added: ModelEntry[] = [...pickerSelection]
      .filter((id) => !existing.has(id))
      .map((id) => ({ id }));
    setModels([...models, ...added]);
    setPickerOpen(false);
    setPickerSelection(new Set());
    setExpanded(null);
    if (added.length > 0 && !testModel) setTestModel(added[0]!.id);
  };

  /**
   * 更新模型条目。
   *
   * 注意 `displayName` 的处理：在 `exactOptionalPropertyTypes` 下，
   * 「`displayName?: string`」表示"要么没有这个键，要么是 string"，
   * 不能显式赋 `undefined`。所以清空时要删键而不是赋 undefined。
   */
  const updateModel = (idx: number, patch: Partial<ModelEntry>) => {
    setModels(
      models.map((m, i) => {
        if (i !== idx) return m;
        const next: ModelEntry = { ...m, ...patch };
        if ('displayName' in patch && !patch.displayName) {
          delete next.displayName;
        }
        // `settings` 同理：`normalizeSettings` 返回 undefined 表示
        // 「这个模型没有任何自定义参数」，那时键要整个消失，
        // 否则存盘会留下一个空的 `"settings": {}`。
        if ('settings' in patch && !patch.settings) {
          delete next.settings;
        }
        return next;
      }),
    );
  };

  const removeModel = (idx: number) => {
    setModels(models.filter((_, i) => i !== idx));
    setExpanded(null);
  };

  const addManualModel = () => {
    setModels([...models, { id: '' }]);
  };

  const handleSave = async () => {
    setLocalError(null);
    setSaving(true);
    try {
      const cleaned = models.filter((m) => m.id.trim() !== '');
      await save(
        { ...initial, name: name.trim(), baseUrl: baseUrl.trim(), protocol, models: cleaned },
        apiKey.trim() || undefined,
      );
      onDone();
    } catch (e) {
      setLocalError(String((e as { message?: string }).message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <button
        type="button"
        onClick={onCancel}
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-ink-400 transition-colors hover:text-ink-200"
      >
        <ArrowLeft size={14} />
        返回列表
      </button>

      <h2 className="text-base font-semibold text-ink-200">
        {isNew ? '添加供应商' : `编辑：${initial.name}`}
      </h2>

      <div className="mt-5 space-y-5">
        {/* ── 基本信息 ── */}
        <section className="space-y-3.5">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-300">
              名称
            </label>
            <input
              className="field"
              placeholder="例如：我的中转站 / OpenAI 官方"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-300">
              Base URL
            </label>
            <input
              className="field font-mono"
              placeholder="https://api.openai.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-ink-600">
              不含具体接口路径，末尾斜杠会被自动处理
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-300">
              API Key
            </label>
            <div className="flex gap-2">
              <input
                className="field font-mono"
                type={showKey ? 'text' : 'password'}
                placeholder={isNew ? 'sk-…' : '留空则沿用已保存的密钥'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="shrink-0 rounded-lg border border-ink-700 px-3 text-xs text-ink-400 transition-colors hover:bg-ink-800"
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-ink-600">
              密钥保存在系统凭据管理器，不写入配置文件，也不会回传到前端
            </p>
          </div>
        </section>

        {/* ── 协议 ── */}
        <section>
          <label className="mb-1.5 block text-xs font-medium text-ink-300">
            接口协议
          </label>
          <div className="grid grid-cols-2 gap-2">
            {(['chat_completions', 'responses'] as const).map((p) => {
              const activeP = protocol === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProtocol(p)}
                  className={[
                    'rounded-lg border p-3 text-left transition-colors',
                    activeP
                      ? 'border-brand-500 bg-brand-500/10'
                      : 'border-ink-700 hover:border-ink-600',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'block text-sm font-medium',
                      activeP ? 'text-brand-400' : 'text-ink-200',
                    ].join(' ')}
                  >
                    {PROTOCOL_LABELS[p]}
                  </span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-ink-500">
                    {PROTOCOL_HINTS[p]}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* ── 模型 ── */}
        <AuraPanel className="p-4" active={isFetching || isProbing}>
          <div className="relative z-10">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-ink-200">模型</h3>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleFetchModels()}
                  disabled={isFetching}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 transition-colors hover:bg-ink-800 disabled:opacity-50"
                >
                  {isFetching ? <OrbitSpinner size={13} /> : <Download size={13} />}
                  {isFetching ? '拉取中…' : '拉取模型列表'}
                </button>
                <button
                  type="button"
                  onClick={addManualModel}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 transition-colors hover:bg-ink-800"
                >
                  <Plus size={13} />
                  手动添加
                </button>
              </div>
            </div>

            {pickerOpen ? (
              <div className="mt-3">
                <ModelPicker
                  models={candidates}
                  selected={pickerSelection}
                  onSelectedChange={setPickerSelection}
                  onClose={() => setPickerOpen(false)}
                  loading={isFetching}
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setPickerOpen(false)}
                    className="rounded-lg px-3 py-1.5 text-xs text-ink-400 hover:bg-ink-800"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={applyPickerSelection}
                    disabled={pickerSelection.size === 0}
                    className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-on-accent transition-colors hover:bg-brand-400 disabled:opacity-40"
                  >
                    添加 {pickerSelection.size} 个模型
                  </button>
                </div>
              </div>
            ) : (
              <>
                {models.length > 0 ? (
                  <p className="mt-3 text-[11px] leading-relaxed text-ink-600">
                    每个模型右侧的滑杆按钮可以设置温度、思考强度、结构化输出与多模态。
                    不确定就留空 —— 留空表示不发送这些参数，一切照旧。
                  </p>
                ) : null}
                {models.length === 0 ? (
                  <p className="mt-3 text-xs text-ink-600">
                    还没有模型。点「拉取模型列表」自动获取，或手动添加。
                  </p>
                ) : (
                  <ul className="mt-3 space-y-1.5">
                    {models.map((m, i) => {
                      const open = expanded === i;
                      const summary = settingsSummary(m.settings);
                      return (
                        <li
                          key={`${m.id}-${i}`}
                          className="rounded-lg border border-transparent transition-colors data-[open=true]:border-ink-800 data-[open=true]:bg-ink-950/40"
                          data-open={open}
                        >
                          <div className="flex items-center gap-2">
                            <input
                              className="field font-mono text-xs"
                              placeholder="模型 ID，如 gpt-4o-mini"
                              value={m.id}
                              onChange={(e) => updateModel(i, { id: e.target.value })}
                            />
                            <input
                              className="field text-xs"
                              placeholder="显示名（可选）"
                              value={m.displayName ?? ''}
                              onChange={(e) =>
                                updateModel(i, { displayName: e.target.value })
                              }
                            />
                            <button
                              type="button"
                              onClick={() => setExpanded(open ? null : i)}
                              aria-expanded={open}
                              className={`shrink-0 rounded-md p-2 transition-colors hover:bg-ink-800 ${
                                open || summary.length > 0
                                  ? 'text-brand-400'
                                  : 'text-ink-600 hover:text-ink-300'
                              }`}
                              title={
                                summary.length > 0
                                  ? `自定义参数：${summary.join(' · ')}`
                                  : '自定义参数（温度 / 思考强度 / 结构化输出 / 多模态）'
                              }
                              aria-label="自定义参数"
                            >
                              <SlidersHorizontal size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeModel(i)}
                              className="shrink-0 rounded-md p-2 text-ink-600 transition-colors hover:bg-ink-800 hover:text-rose-500"
                              aria-label="移除该模型"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>

                          {/* 收起来时也要看得见「这个模型设过东西」——
                              否则用户改完参数收起面板，就再也想不起来
                              当初为什么这个模型表现不一样。 */}
                          {!open && summary.length > 0 ? (
                            <p className="px-1 pb-1 pt-1 text-[11px] text-ink-600">
                              {summary.join(' · ')}
                            </p>
                          ) : null}

                          {open ? (
                            <div className="p-2 pt-1.5">
                              <ModelSettingsPanel
                                settings={m.settings}
                                onChange={(next) => updateModel(i, { settings: next })}
                              />
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
        </AuraPanel>

        {/* ── 连通性测试 ── */}
        <section className="rounded-lg border border-ink-800 bg-ink-900 p-4">
          <h3 className="text-sm font-medium text-ink-200">连通性测试</h3>
          <div className="mt-2.5 flex gap-2">
            {models.length > 0 ? (
              <select
                className="field"
                value={testModel}
                onChange={(e) => setTestModel(e.target.value)}
              >
                <option value="">（选择模型）</option>
                {models
                  .filter((m) => m.id.trim())
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName ? `${m.displayName}（${m.id}）` : m.id}
                    </option>
                  ))}
              </select>
            ) : (
              <input
                className="field font-mono"
                placeholder="模型 ID"
                value={testModel}
                onChange={(e) => setTestModel(e.target.value)}
              />
            )}
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={isProbing}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-700 px-3.5 py-2 text-xs text-ink-300 transition-colors hover:bg-ink-800 disabled:opacity-50"
            >
              {isProbing ? <OrbitSpinner size={13} /> : <Zap size={13} />}
              {isProbing ? '测试中…' : '测试'}
            </button>
          </div>

          {probeResult ? (
            <div
              className={[
                'mt-3 rounded-lg border p-3 text-xs leading-relaxed',
                probeResult.ok
                  ? 'border-teal-500/30 bg-teal-500/10'
                  : 'border-rose-500/30 bg-rose-500/10',
              ].join(' ')}
            >
              {probeResult.ok ? (
                <div className="text-teal-500">
                  <p className="font-medium">
                    连通成功 · 往返 {probeResult.latencyMs ?? '?'} ms
                  </p>
                  {probeResult.capabilities ? (
                    <p className="mt-1.5 text-teal-500/80">
                      端点能力：
                      {probeResult.capabilities.listModels ? ' 模型列表 ✓' : ' 模型列表 ✗'}
                      {probeResult.capabilities.streaming ? ' · 流式 ✓' : ' · 流式 ✗'}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="whitespace-pre-wrap text-rose-500">{probeResult.error}</p>
              )}
            </div>
          ) : null}
        </section>

        {localError ? (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3">
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-rose-500">
              {localError}
            </p>
          </div>
        ) : null}
        {notice && !localError ? (
          <p className="text-xs text-teal-500">{notice}</p>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-ink-800 pt-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm text-ink-300 transition-colors hover:bg-ink-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !name.trim() || !baseUrl.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
