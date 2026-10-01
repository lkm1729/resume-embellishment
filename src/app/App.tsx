import { useEffect, useState } from 'react';
import { useProviderStore } from '@/core/llm/store';
import { useExportStore } from '@/core/store/export';
import { useThemeStore } from '@/core/ui/theme';
import { ProviderSettings } from '@/features/providers/ProviderSettings';
import { Workbench } from '@/features/editor/Workbench';
import { HistoryPanel } from '@/features/history/HistoryPanel';
import { SidebarFooter } from '@/features/shell/SidebarFooter';
import { FileText, Mail, Plug, History } from 'lucide-react';

type Tab = 'resume' | 'cover' | 'providers' | 'history';

const TABS: Array<{ id: Tab; label: string; icon: typeof FileText; hint: string }> = [
  { id: 'resume', label: '简历美化', icon: FileText, hint: '排版与视觉设计' },
  { id: 'cover', label: '求职信美化', icon: Mail, hint: '排版与视觉设计' },
  { id: 'providers', label: '模型供应商', icon: Plug, hint: '自备 API' },
  { id: 'history', label: '历史记录', icon: History, hint: '回滚与删除' },
];

export default function App() {
  // 默认打开「简历美化」—— 这是这个工具的主线任务。
  // 供应商只在生成时才需要，不该让用户一进来就先面对设置页。
  const [tab, setTab] = useState<Tab>('resume');
  const load = useProviderStore((s) => s.load);
  const checkKeyring = useProviderStore((s) => s.checkKeyring);
  const keyringError = useProviderStore((s) => s.keyringError);
  const providers = useProviderStore((s) => s.providers);
  const exporting = useExportStore((s) => s.exporting);
  const initTheme = useThemeStore((s) => s.init);

  useEffect(() => {
    void checkKeyring();
    void load();
  }, [checkKeyring, load]);

  // 主题：读缓存并落地，再订阅系统变化。
  // 放在 effect 里而不是模块顶层，是为了让返回的清理函数能解绑监听器
  // （模块顶层订阅在 HMR 下会累积监听器）。
  useEffect(() => initTheme(), [initTheme]);

  /**
   * 导出视图。
   *
   * `PrintToPdfAsync` 打印的是整个 webview，所以导出期间
   * 页面上必须**只剩待导出的文档** —— 否则侧边栏、输入框、
   * 工具条都会出现在 PDF 里。
   *
   * 这里提前 return，整个应用壳都不渲染。
   */
  if (exporting) {
    return (
      <div
        className="export-root"
        // 内容已在渲染层转义，DesignSpec 字段受 zod 约束
        // （字体那一处例外在 render.ts 的 fontStack 里单独转义）
        dangerouslySetInnerHTML={{ __html: exporting.html }}
      />
    );
  }

  /** 还没配供应商时，工作台顶部提醒一句，并给一个直达入口。 */
  const providerWarning =
    providers.length === 0
      ? {
          text: '还没有配置模型供应商。生成需要你自己的 API，请先添加。',
          action: '去配置',
          onAction: () => setTab('providers'),
        }
      : null;

  return (
    <div className="flex h-full">
      {/* 侧边栏 */}
      <nav className="flex w-56 shrink-0 flex-col border-r border-ink-800 bg-ink-900">
        <div className="px-4 py-5">
          <h1 className="text-sm font-semibold tracking-wide text-ink-200">
            简历与求职信美化
          </h1>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-600">
            只改版式，不改文字
          </p>
        </div>

        <div className="flex-1 space-y-1 px-2">
          {TABS.map(({ id, label, icon: Icon, hint }) => {
            const activeTab = tab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-current={activeTab ? 'page' : undefined}
                className={[
                  'group relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left',
                  // 过渡只动颜色与位移（走合成器），不动尺寸
                  'transition-colors duration-150',
                  activeTab
                    ? 'bg-ink-800 text-ink-200'
                    : 'text-ink-400 hover:bg-ink-850 hover:text-ink-300',
                ].join(' ')}
              >
                {/* 选中指示条：用 scaleY 展开，比突然出现有"落定"感。
                    放在按钮内部是刻意的 —— 避免跨项测量（列表长度可变）。 */}
                <span
                  aria-hidden="true"
                  className={[
                    'absolute inset-y-1.5 left-0 w-0.5 origin-center rounded-full bg-brand-500',
                    'transition-transform duration-200 ease-out',
                    activeTab ? 'scale-y-100' : 'scale-y-0',
                  ].join(' ')}
                />
                <Icon
                  size={16}
                  className={[
                    'transition-[color,transform] duration-200',
                    activeTab ? 'text-brand-500' : 'group-hover:translate-x-0.5',
                  ].join(' ')}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{label}</span>
                  <span className="block text-[10px] text-ink-600">{hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        {/* 底部状态条：版本号 + 主题开关（密钥环错误浮在其上） */}
        <SidebarFooter keyringError={keyringError} />
      </nav>

      {/* 主内容区 */}
      <main className="min-h-0 flex-1 overflow-y-auto bg-ink-950">
        {providerWarning && (tab === 'resume' || tab === 'cover') ? (
          <div className="mx-auto mt-4 flex max-w-4xl items-center gap-3 rounded-lg border border-warn-500/30 bg-warn-500/10 px-4 py-2.5">
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-warn-300">
              {providerWarning.text}
            </p>
            <button
              type="button"
              onClick={providerWarning.onAction}
              className="shrink-0 rounded-md bg-warn-500 px-2.5 py-1 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
            >
              {providerWarning.action}
            </button>
          </div>
        ) : null}

        {/* key 让切换标签时重新挂载，从而触发一次入场淡入。
            这是「面板活了」最省成本的实现：一个 key + 一个动画类，
            不引入动画库，也不常驻任何状态。 */}
        <div key={tab} className="fade-in">
          {tab === 'providers' ? <ProviderSettings /> : null}
          {tab === 'resume' ? <Workbench type="resume" /> : null}
          {tab === 'cover' ? <Workbench type="cover-letter" /> : null}
          {tab === 'history' ? <HistoryPanel /> : null}
        </div>
      </main>
    </div>
  );
}
