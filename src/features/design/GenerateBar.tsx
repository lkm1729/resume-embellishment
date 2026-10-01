/**
 * 生成区。
 *
 * 对应需求的三条视觉效果：
 *   1. 生成按钮旁显示供应商 / 模型名称（接口协议）/ 生成时间
 *   2. 生成中显示「简历生成中」/「求职信生成中」渐变文字 + 动态加载图标
 *   3. 生成板块用更有指向性的特效与材质
 *
 * 另外承担一个容易被忽略但很重要的职责：
 * **如实告知这次生成的质量**。走了哪层回退、是否用了保守兜底、
 * 参考资料被裁掉多少 —— 这些用户有权知道。
 * 悄悄兜底会让他以为模型为他做了设计，而实际上拿到的是模板。
 */

import { useState } from 'react';
import { Sparkles, ChevronDown, TriangleAlert, Info, Wand2 } from 'lucide-react';
import type { DocType } from '@/core/store/workbench';
import { useWorkbenchStore } from '@/core/store/workbench';
import { useGenerationStore } from '@/core/store/generation';
import { useProviderStore } from '@/core/llm/store';
import { buildLocalFallbackSpec } from '@/core/design/generate';
import { PROTOCOL_LABELS } from '@/core/llm/types';
import { GenerationDoneBar } from './GenerationDoneBar';
import {
  AuraPanel,
  GenerateButton,
  GeneratingBadge,
  ModelChip,
} from '@/components/effects';

/** 策略层级的中文说明，让用户看懂"端点实际支持到什么程度"。 */
const STRATEGY_LABELS: Record<string, string> = {
  json_schema: '原生 JSON Schema（最可靠）',
  json_object: 'JSON 模式 + 提示词内嵌 schema',
  text: '纯文本 + 自动提取 JSON',
};

export function GenerateBar({ type }: { type: DocType }) {
  const docLabel = type === 'resume' ? '简历' : '求职信';

  const parsed = useWorkbenchStore((s) => s.parsed[type]);
  const input = useWorkbenchStore((s) => s.inputs[type]);

  const status = useGenerationStore((s) => s.status[type]);
  const run = useGenerationStore((s) => s.run[type]);
  // 只用来决定「生成完成」提示是否出现：没有版式就没有可报的生成结果
  const spec = useGenerationStore((s) => s.spec[type]);
  const outcome = useGenerationStore((s) => s.outcome[type]);
  const error = useGenerationStore((s) => s.error[type]);
  const downgrade = useGenerationStore((s) => s.downgrade[type]);
  const generate = useGenerationStore((s) => s.generate);
  const applySpec = useGenerationStore((s) => s.applySpec);

  const providers = useProviderStore((s) => s.providers);

  // 默认选中第一个供应商的第一个模型
  const [providerId, setProviderId] = useState<string>('');
  const [modelId, setModelId] = useState<string>('');

  const provider =
    providers.find((p) => p.id === providerId) ?? providers[0] ?? undefined;
  const model =
    provider?.models.find((m) => m.id === modelId) ?? provider?.models[0] ?? undefined;

  const ready = !!parsed && parsed.units.length > 0;
  const canGenerate = ready && !!provider && !!model && status !== 'generating';

  const handleGenerate = () => {
    if (!provider || !model) return;
    void generate(type, {
      providerId: provider.id,
      providerName: provider.name,
      modelId: model.id,
      modelName: model.displayName || model.id,
      protocol: provider.protocol,
      capabilities: provider.lastProbe?.capabilities,
      // 这个模型的自定义参数（温度 / 思考强度 / 结构化输出 / 多模态）。
      // 在这里随目标一起带走，而不是让 store 回头去查供应商配置 ——
      // 生成期间用户改了设置，不该影响已经在跑的这一轮。
      settings: model.settings,
    });
  };

  /** 本地兜底版式：不调用模型，让渲染与导出链路可以独立工作。 */
  const handleLocalPreview = () => {
    if (!parsed) return;
    applySpec(type, buildLocalFallbackSpec(parsed.units, parsed.sections, type));
  };

  return (
    <AuraPanel className="p-4" active={status === 'generating'}>
      <div className="relative z-10 space-y-3">
        {/* ── 标题行 ── */}
        <div className="flex items-center gap-2">
          <Wand2 size={15} className="text-brand-400" />
          <h3 className="text-sm font-medium text-ink-200">生成版式</h3>
          <span className="text-[11px] text-ink-600">
            模型只决定排版，你的文字不会被改动
          </span>
        </div>

        {/* ── 模型选择 ── */}
        {providers.length === 0 ? (
          <p className="rounded-lg border border-ink-700 bg-ink-900/60 p-3 text-[11px] leading-relaxed text-ink-400">
            还没有配置模型供应商。生成需要你自己的 API ——
            请到左侧「模型供应商」添加 Base URL 与 API Key。
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <select
                className="field appearance-none pr-8 text-xs"
                value={provider?.id ?? ''}
                onChange={(e) => {
                  setProviderId(e.target.value);
                  setModelId('');
                }}
                aria-label="选择供应商"
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={13}
                className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-600"
              />
            </div>

            <div className="relative min-w-0 flex-1">
              <select
                className="field appearance-none pr-8 text-xs"
                value={model?.id ?? ''}
                onChange={(e) => setModelId(e.target.value)}
                aria-label="选择模型"
              >
                {provider?.models.length === 0 ? (
                  <option value="">（该供应商还没有模型）</option>
                ) : null}
                {provider?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName ? `${m.displayName}（${m.id}）` : m.id}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={13}
                className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-600"
              />
            </div>
          </div>
        )}

        {/* ── 按钮行（视觉1：模型信息 + 生成时间） ── */}
        <div className="flex flex-wrap items-center gap-3">
          <GenerateButton
            label={`生成${docLabel}版式`}
            generatingLabel="生成中…"
            generating={status === 'generating'}
            disabled={!canGenerate}
            onClick={handleGenerate}
          />

          <button
            type="button"
            onClick={handleLocalPreview}
            disabled={!ready}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-2 text-xs text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-300 disabled:opacity-40"
            title="不调用模型，直接用默认版式渲染，用来预览与导出"
          >
            <Sparkles size={13} />
            默认版式预览
          </button>

          {run ? (
            <ModelChip
              providerName={run.providerName}
              modelName={run.modelName}
              protocolLabel={PROTOCOL_LABELS[run.protocol]}
              generatedAt={run.at}
            />
          ) : null}
        </div>

        {/* ── 生成中（视觉2：渐变文字 + 动态图标） ── */}
        {status === 'generating' ? (
          <div className="space-y-2">
            <GeneratingBadge
              label={`${docLabel}生成中`}
              {...(parsed
                ? { detail: `正在为 ${parsed.units.length} 个内容单元设计版式…` }
                : {})}
            />
            {/* 不定长进度条：让"还在动"这件事可见。
                纯 CSS（transform 平移），不引入任何状态。 */}
            <div
              className="progress-track h-0.5 w-full overflow-hidden rounded-full bg-ink-800"
              role="progressbar"
              aria-label="生成进度"
            />
          </div>
        ) : null}

        {/* ── 生成完成提示（按钮正下方） ──
            需求 3.1：同一份「生成完成」提示也要出现在生成按钮下面 ——
            点完按钮之后视线还停在这里，不必立刻把目光移到右侧预览板。

            只在真的有版式时才显示：还没生成过的时候这块会写
            「这份版式是本地兜底预览」，而那时根本还没有版式，
            那句话就成了假的。 */}
        {spec ? <GenerationDoneBar type={type} /> : null}

        {/* ── 结果质量提示 ── */}
        {outcome?.usedConservativeFallback ? (
          <Note tone="warn" icon={<TriangleAlert size={13} />}>
            模型多次未能产出合法结构，已改用**保守兜底版式**。
            结果是合法的，但设计判断有限 —— 建议换用能力更强的模型重新生成。
          </Note>
        ) : null}

        {outcome?.strategy ? (
          <Note tone="info" icon={<Info size={13} />}>
            本次使用：{STRATEGY_LABELS[outcome.strategy] ?? outcome.strategy}
            {outcome.droppedReferences > 0 ? (
              <>
                {' '}
                · 参考资料超出上下文预算，已自动舍弃 {outcome.droppedReferences} 条
                （仅影响设计参考，正文不受影响）
              </>
            ) : null}
          </Note>
        ) : null}

        {downgrade ? (
          <Note tone="warn" icon={<TriangleAlert size={13} />}>
            {downgrade}
          </Note>
        ) : null}

        {/* 贴了图却一张都没发出去，必须说一声 ——
            否则用户只会看到模型完全没提图片，以为是粘贴失败了。 */}
        {outcome && outcome.skippedImages > 0 ? (
          <Note tone="info" icon={<Info size={13} />}>
            这个模型的设置里关掉了多模态，已跳过 {outcome.skippedImages} 张参考图。
            需要模型看图的话，到「模型供应商」里展开这个模型，把多模态打开。
          </Note>
        ) : null}

        {error ? (
          <Note tone="error" icon={<TriangleAlert size={13} />}>
            {error}
          </Note>
        ) : null}

        {/* ── 内容与风格的即时摘要 ── */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-600">
          <span>
            {parsed
              ? `${parsed.units.length} 个单元 · ${parsed.sections.length} 个板块`
              : '尚未填入正文'}
          </span>
          <span>·</span>
          <span>{input.presetId ? '已选预设风格' : '未选预设'}</span>
          {input.customStyle.trim() ? (
            <>
              <span>·</span>
              <span>含自定义要求</span>
            </>
          ) : null}
          <span>·</span>
          <span>
            {input.references.filter((r) => r.role === 'primary').length} 条正文参考
          </span>
        </div>
      </div>
    </AuraPanel>
  );
}

/** 统一的结果提示条。 */
function Note({
  tone,
  icon,
  children,
}: {
  tone: 'info' | 'warn' | 'error';
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const styles = {
    info: 'border-ink-700 bg-ink-900/60 text-ink-400',
    warn: 'border-warn-500/30 bg-warn-500/10 text-warn-300',
    error: 'border-rose-500/30 bg-rose-500/10 text-rose-500',
  }[tone];

  return (
    <div className={`flex items-start gap-2 rounded-lg border p-2.5 ${styles}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <p className="min-w-0 whitespace-pre-wrap text-[11px] leading-relaxed">{children}</p>
    </div>
  );
}
