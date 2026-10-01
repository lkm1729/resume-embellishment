/**
 * 方块 2：目标岗位资料。
 * 方块 3：额外补充资料。
 *
 * 这两块的共同点（也是它们与方块 1 的关键区别）：
 * **内容不会出现在成品里**，只用来影响设计决策。
 *
 * 所以界面必须把这件事说清楚。用户如果以为"我写的岗位描述会印在简历上"，
 * 就会不敢写详细 —— 那反而削弱了这块的价值。
 */

import { Briefcase, NotebookPen } from 'lucide-react';
import type { DocType } from '@/core/store/workbench';
import { useWorkbenchStore } from '@/core/store/workbench';
import { InputBlock } from './InputBlock';

export function TargetRoleBlock({ type }: { type: DocType }) {
  const value = useWorkbenchStore((s) => s.inputs[type].targetRole);
  const setTargetRole = useWorkbenchStore((s) => s.setTargetRole);

  return (
    <InputBlock
      index={2}
      title="目标岗位资料"
      hint="粘贴 JD 或写下目标岗位。用于判断该突出什么、风格该往哪边靠。不会出现在成品里。"
    >
      <textarea
        className="field min-h-[110px] resize-y text-[13px] leading-relaxed"
        placeholder={
          '例如：\n某公司 前端工程师\n职责：负责交易链路前端架构、性能优化、组件库建设\n要求：5 年以上经验，精通 TypeScript / React，有大型项目经验'
        }
        value={value}
        onChange={(e) => setTargetRole(type, e.target.value)}
      />
      <Notice icon={<Briefcase size={11} />}>
        JD 里的关键词会影响排版侧重（比如"性能优化"会被判断为需要突出数据的岗位，
        从而更倾向紧凑、数据对齐的版式），但 JD 原文不会被渲染。
      </Notice>
    </InputBlock>
  );
}

export function ExtraNotesBlock({ type }: { type: DocType }) {
  const value = useWorkbenchStore((s) => s.inputs[type].extraNotes);
  const setExtraNotes = useWorkbenchStore((s) => s.setExtraNotes);

  return (
    <InputBlock
      index={3}
      title="额外补充资料"
      hint="任何想让我知道的信息 —— 投递渠道、行业偏好、必须避免的颜色等。不会出现在成品里。"
    >
      <textarea
        className="field min-h-[90px] resize-y text-[13px] leading-relaxed"
        placeholder={
          '例如：\n投递的是一家传统制造业国企，希望风格保守一些；\n不要用红色，公司 VI 是蓝色系；\n这份简历会被打印出来，请保证黑白打印也能看清层级。'
        }
        value={value}
        onChange={(e) => setExtraNotes(type, e.target.value)}
      />
      <Notice icon={<NotebookPen size={11} />}>
        这里的文字用来约束设计取舍，同样不会被渲染进成品。
      </Notice>
    </InputBlock>
  );
}

/** 统一的"这段文字去哪了"提示。反复出现是为了消除用户的核心疑虑。 */
function Notice({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-600">
      <span className="mt-0.5 shrink-0 text-ink-600">{icon}</span>
      <span className="min-w-0">{children}</span>
    </p>
  );
}
