/**
 * 方块 8：继续调整。
 *
 * ═══════════════════════════════════════════════════════════════
 *  为什么要有这一块，而不是让用户回去改「自定义风格要求」再生成：
 *
 *  那是**重新设计**。模型每次都从零开始排版，用户上一轮碰巧
 *  满意的地方（某个间距、某个标题大小）会被一并重新掷骰子。
 *  连着试几次都在原地打转，人就会放弃这个功能。
 *
 *  这里做的是**增量调整**：把当前 spec 一起发给模型，
 *  并明确要求只改用户指出的那部分。其余字段逐一保持原值。
 * ═══════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import { ChevronDown, Send, TriangleAlert, Undo2, Wand2 } from 'lucide-react';
import type { DocType } from '@/core/store/workbench';
import { useGenerationStore } from '@/core/store/generation';
import { useProviderStore } from '@/core/llm/store';
import { InputBlock } from './InputBlock';

/** 几条起点，点一下就填进输入框。用户可以直接改，不必照抄。 */
const QUICK_IDEAS = [
  '标题再大一点，和正文拉开差距',
  '整体留白多一些，别那么挤',
  '换一个更沉稳的配色（深蓝 / 灰）',
  '板块之间的分隔再明显一点',
  '强调色用得太多，收敛到只用在标题和分隔线上',
  '正文行距松一点，更好读',
];

export function RefineBlock({ type }: { type: DocType }) {
  const spec = useGenerationStore((s) => s.spec[type]);
  const status = useGenerationStore((s) => s.status[type]);
  const refinements = useGenerationStore((s) => s.refinements[type]);
  const specStack = useGenerationStore((s) => s.specStack[type]);
  const run = useGenerationStore((s) => s.run[type]);
  const outcome = useGenerationStore((s) => s.outcome[type]);
  const refine = useGenerationStore((s) => s.refine);
  const undoRefinement = useGenerationStore((s) => s.undoRefinement);

  const providers = useProviderStore((s) => s.providers);

  const [text, setText] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const busy = status === 'generating';

  // 模型沿用生成时用的那个 —— 调整和生成必须是同一个模型，
  // 换模型会带来一整套新的设计倾向，那就不是"调整"了。
  const provider =
    (run ? providers.find((p) => p.id === run.providerId) : undefined) ?? providers[0];
  const model = run
    ? provider?.models.find((m) => m.id === run.modelId) ?? provider?.models[0]
    : provider?.models[0];

  const canRefine = !!spec && !!provider && !!model && text.trim().length > 0 && !busy;

  const handleRefine = async () => {
    if (!provider || !model || text.trim().length === 0) return;
    const ok = await refine(
      type,
      {
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        modelName: model.displayName || model.id,
        protocol: provider.protocol,
        capabilities: provider.lastProbe?.capabilities,
        // 「继续调整」沿用同一个模型的参数，否则同一个模型
        // 在生成与调整两条路径上的表现会不一致
        settings: model.settings,
      },
      text,
    );
    // 失败时**不清空输入** —— 用户多半想改几个字再试一次，
    // 让他重新打一遍是最没必要的摩擦。
    if (ok) setText('');
  };

  // 还没生成过就没有可调整的对象。这时不显示这一块，
  // 而不是显示一个禁用的空壳 —— 那只会让人问"为什么点不动"。
  if (!spec) return null;

  const applied = refinements.filter((r) => r.ok).length;

  return (
    <InputBlock
      index={8}
      title="继续调整"
      hint="在现在这版上继续改。模型只动你提到的地方，其余部分保持原样 —— 不会被重新设计。"
      badge={
        applied > 0 ? (
          <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400">
            已调整 {applied} 轮
          </span>
        ) : null
      }
    >
      <textarea
        className="field min-h-[64px] resize-y text-[13px] leading-relaxed"
        placeholder="例如：把标题再放大一些，正文行距松开一点。可以只说一处，也可以一次说几条。"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Ctrl/Cmd + Enter 提交：这样普通的回车仍能用来换行。
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canRefine) {
            void handleRefine();
          }
        }}
        disabled={busy}
      />

      <div className="mt-2 flex flex-wrap gap-1.5">
        {QUICK_IDEAS.map((idea) => (
          <button
            key={idea}
            type="button"
            onClick={() => setText((prev) => (prev.trim() ? `${prev.trim()}\n${idea}` : idea))}
            disabled={busy}
            className="rounded-full border border-ink-800 px-2 py-0.5 text-[10px] text-ink-500 transition-colors hover:border-ink-700 hover:text-ink-300 disabled:opacity-40"
          >
            {idea}
          </button>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleRefine()}
          disabled={!canRefine}
          className="inline-flex items-center gap-1.5 rounded-lg border border-brand-500/40 bg-brand-500/10 px-3 py-1.5 text-xs text-brand-400 transition-colors hover:bg-brand-500/20 disabled:opacity-40"
        >
          <Send size={13} />
          {busy ? '调整中…' : '应用调整'}
        </button>

        {specStack.length > 0 ? (
          <button
            type="button"
            onClick={() => undoRefinement(type)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-300 disabled:opacity-40"
            title="退回上一版版式"
          >
            <Undo2 size={13} />
            撤销这一步
          </button>
        ) : null}

        <span className="text-[10px] text-ink-600">Ctrl + Enter 提交</span>
      </div>

      {outcome?.usedConservativeFallback ? (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-warn-400">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          这一版是保守兜底版式，可调整的余地有限。建议先用能力更强的模型重新生成。
        </p>
      ) : null}

      {/* ── 调整历史 ── */}
      {refinements.length > 0 ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
            className="flex items-center gap-1 text-[11px] text-ink-600 transition-colors hover:text-ink-400"
          >
            <ChevronDown
              size={12}
              className={showHistory ? 'rotate-180 transition-transform' : 'transition-transform'}
            />
            调整记录（{refinements.length}）
          </button>

          {showHistory ? (
            <ul className="mt-2 space-y-1.5">
              {refinements.map((r, i) => (
                <li
                  key={`${r.at}-${i}`}
                  className="rounded-lg border border-ink-800 bg-ink-950/50 p-2"
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={[
                        'mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                        r.ok ? 'bg-teal-500/15 text-teal-500' : 'bg-rose-500/15 text-rose-500',
                      ].join(' ')}
                    >
                      {r.ok ? '已应用' : '失败'}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap text-[11px] leading-relaxed text-ink-400">
                      {r.instruction}
                    </span>
                  </div>
                  {r.error ? (
                    <p className="mt-1 whitespace-pre-wrap text-[10px] leading-relaxed text-rose-500">
                      {r.error}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-600">
        <Wand2 size={12} className="mt-0.5 shrink-0" />
        每次调整都会存一份历史快照，随时能在「历史记录」里回到之前的版本。
        调整失败不会影响当前版式。
      </p>
    </InputBlock>
  );
}
