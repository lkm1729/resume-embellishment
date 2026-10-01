/**
 * 方块 1：正文输入。
 *
 * 除了输入框，这里还做一件重要的事：**把解析结果摊给用户看**。
 *
 * 为什么值得展示：用户最担心的就是"工具会不会改我的字"。
 * 与其用一句"我们不会改"来保证，不如直接列出解析出的内容单元，
 * 让他自己数一数 —— 可验证的信任比承诺可靠。
 */

import { useEffect, useRef } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { DocType } from '@/core/store/workbench';
import { useWorkbenchStore } from '@/core/store/workbench';
import { InputBlock, ModeSwitch } from './InputBlock';
import { RelativeTime } from '@/components/effects';

/** 单元类型的中文名，用于预览。 */
const KIND_LABELS: Record<string, string> = {
  heading: '标题',
  paragraph: '段落',
  listItem: '条目',
  contact: '联系',
  date: '日期',
  meta: '表格',
};

export function MainTextBlock({ type }: { type: DocType }) {
  const input = useWorkbenchStore((s) => s.inputs[type]);
  const parsed = useWorkbenchStore((s) => s.parsed[type]);
  const parsedAt = useWorkbenchStore((s) => s.parsedAt[type]);
  const parsing = useWorkbenchStore((s) => s.parsing[type]);
  const parseError = useWorkbenchStore((s) => s.parseError[type]);
  const setMainText = useWorkbenchStore((s) => s.setMainText);
  const setMainMode = useWorkbenchStore((s) => s.setMainMode);
  const reparse = useWorkbenchStore((s) => s.reparse);

  // 输入停止后 300ms 再解析：解析会算 SHA-256，
  // 每敲一个字就跑一遍会白耗算力，也让预览闪烁。
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void reparse(type);
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [input.mainText, input.mainMode, type, reparse]);

  const unitCount = parsed?.units.length ?? 0;
  const sectionCount = parsed?.sections.length ?? 0;
  const charCount = input.mainText.length;

  return (
    <InputBlock
      index={1}
      title={type === 'resume' ? '简历正文' : '求职信正文'}
      hint="粘贴或输入你的原文。这里的内容会被逐字保留 —— 只改版式，不改文字。"
      badge={
        <ModeSwitch
          mode={input.mainMode}
          onChange={(m) => setMainMode(type, m)}
        />
      }
    >
      <textarea
        className="field min-h-[220px] resize-y font-mono text-[13px] leading-relaxed"
        placeholder={
          type === 'resume'
            ? '张伟\n高级前端工程师\n138-0000-0000 | zhangwei@example.com\n\n教育背景\n2018.09 - 2022.06  清华大学  计算机科学与技术  本科\n\n工作经历\n2022.07 - 至今  某科技公司  前端工程师\n- 负责核心交易链路的前端架构设计'
            : '尊敬的招聘负责人：\n\n我在贵公司官网看到前端工程师的招聘信息，希望能有机会参与其中。\n\n（粘贴你的求职信原文）'
        }
        value={input.mainText}
        onChange={(e) => setMainText(type, e.target.value)}
        spellCheck={false}
      />

      {/* ── 解析状态 ── */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-600">
        <span>{charCount} 字符</span>
        {parsing ? (
          <span className="text-ink-400">解析中…</span>
        ) : parsed ? (
          <>
            <span className="text-ink-600">·</span>
            <span className="text-teal-500">
              {unitCount} 个内容单元 · {sectionCount} 个板块
            </span>
            <span className="text-ink-600">·</span>
            <span title={parsed.contentHash}>
              指纹 {parsed.contentHash.slice(0, 8)}
            </span>
          </>
        ) : null}
      </div>

      {parseError ? (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-rose-500">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          {parseError}
        </p>
      ) : null}

      {/* ── 单元预览 ──
          让用户亲眼确认"我的字一个都没少、一个都没变"。 */}
      {parsed && parsed.units.length > 0 ? (
        <details className="mt-3 rounded-lg border border-ink-800 bg-ink-950/60">
          <summary className="cursor-pointer select-none px-3 py-2 text-[11px] text-ink-400 hover:text-ink-300">
            查看解析出的内容单元（{unitCount} 个）
          </summary>
          <ul className="max-h-64 space-y-0.5 overflow-y-auto border-t border-ink-800 p-2">
            {parsed.units.map((u) => (
              <li key={u.id} className="flex items-start gap-2 rounded px-1.5 py-1 text-[11px]">
                <span className="shrink-0 font-mono text-ink-600">{u.id}</span>
                <span className="shrink-0 rounded bg-ink-800 px-1 text-[10px] text-ink-400">
                  {KIND_LABELS[u.kind] ?? u.kind}
                </span>
                {u.meta?.role ? (
                  <span className="shrink-0 rounded bg-brand-500/15 px-1 text-[10px] text-brand-400">
                    头部·{String(u.meta.role)}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 break-words text-ink-300">{u.text}</span>
              </li>
            ))}
          </ul>
          <p className="border-t border-ink-800 px-3 py-2 text-[10px] leading-relaxed text-ink-600">
            以上即你的原文。生成时模型只能引用这些单元的编号，无法写入或改写任何文字。
            {parsedAt ? (
              <>
                {' '}解析于 <RelativeTime at={parsedAt} />
              </>
            ) : null}
          </p>
        </details>
      ) : null}
    </InputBlock>
  );
}
