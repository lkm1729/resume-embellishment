/**
 * 工作台 —— 输入区 + 生成区 + 预览板。
 *
 * 布局：左侧输入（可滚动），右侧预览（固定在视口内）。
 *
 * 为什么预览要固定而不是跟着一起滚：
 * 用户改一个风格参数、换一个预设，最想看的就是"右边变成什么样了"。
 * 如果预览在页面底部，他每次都要滚下去再滚回来 ——
 * 那种反馈延迟会让人放弃尝试。
 */

import { useState } from 'react';
import { Info, PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { DocType } from '@/core/store/workbench';
import { useWorkbenchStore } from '@/core/store/workbench';
import { useGenerationStore } from '@/core/store/generation';
import { MainTextBlock } from './MainTextBlock';
import { ExtraNotesBlock, TargetRoleBlock } from './ContextBlocks';
import { PasteFileBlock, UrlBlock } from './ReferenceBlocks';
import { StyleBlock } from './StyleBlock';
import { FontBlock } from './FontBlock';
import { RefineBlock } from './RefineBlock';
import { GenerateBar } from '@/features/design/GenerateBar';
import { PreviewPanel } from '@/features/preview/PreviewPanel';
import { useEffectiveSpec } from '@/core/fonts/effective';

export function Workbench({ type }: { type: DocType }) {
  const parsed = useWorkbenchStore((s) => s.parsed[type]);
  const reset = useWorkbenchStore((s) => s.reset);
  const clearSpec = useGenerationStore((s) => s.clear);
  // 预览要看到的是**叠加了用户字体选择**的最终样子，
  // 不是模型原样吐出的那份。两者只在用户改过字体时有差别。
  const spec = useEffectiveSpec(type);

  const [showPreview, setShowPreview] = useState(true);

  const handleReset = () => {
    reset(type);
    clearSpec(type);
  };

  return (
    <div className="flex h-full min-h-0">
      {/* ── 左：输入区 ── */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-6">
          <header className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-ink-200">
                {type === 'resume' ? '简历视觉设计' : '求职信视觉设计'}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-ink-400">
                只做排版美化：字体、配色、间距、版式。你的文字会被逐字保留。
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setShowPreview((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-300"
                title={showPreview ? '隐藏预览' : '显示预览'}
              >
                {showPreview ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
                {showPreview ? '隐藏预览' : '显示预览'}
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-300"
              >
                清空
              </button>
            </div>
          </header>

          {/*
            顶部提示：说清楚这个工具的边界，以及拿到成品之后该去哪。
            放在标题下面而不是折叠进帮助里 —— 用户对成品不满意时最需要
            知道的就是"接下来该用什么修"，而那一刻他不会去翻帮助。
            Word 优先是因为 .docx 是对方真正要改动时唯一方便的形式；
            Google Docs 那一环是排版微调，本工具做不到逐像素符合预期。
          */}
          <p className="mb-4 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-500">
            <Info size={12} className="mt-0.5 shrink-0 text-ink-600" aria-hidden="true" />
            <span>
              建议使用 Word 输出，并使用 Google Docs 进一步检查和整理排版美化；此工具不能 100%
              符合您的审美预期。
            </span>
          </p>

          <div className="space-y-4">
            <MainTextBlock type={type} />
            <TargetRoleBlock type={type} />
            <ExtraNotesBlock type={type} />
            <PasteFileBlock type={type} />
            <UrlBlock type={type} />
            <StyleBlock type={type} />
            {/*
              方块 7 挨着风格：都是"生成之前先把要求说清楚"的输入，
              放在一起用户不用在两个地方来回找。
            */}
            <FontBlock type={type} />
            <GenerateBar type={type} />
            {/*
              方块 8 紧跟在生成条之后：用户点完「生成版式」、
              在右边看过效果，下一个念头就是"这里再改一下"。
              RefineBlock 在没生成过时自己返回 null，所以这里不必判断。
            */}
            <RefineBlock type={type} />
          </div>
        </div>
      </div>

      {/* ── 右：预览板 ── */}
      {showPreview ? (
        <aside className="hidden w-[560px] shrink-0 border-l border-ink-800 bg-ink-900 lg:block">
          <PreviewPanel
            units={parsed?.units ?? []}
            spec={spec}
            docLabel={type === 'resume' ? '简历预览' : '求职信预览'}
            docType={type}
          />
        </aside>
      ) : null}
    </div>
  );
}
