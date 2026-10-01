/**
 * 首次使用 Google Docs 同步前的配置向导。
 *
 * 这条路绕不过一次人工准备：Google 只给「注册过的程序」发通行证，
 * Client ID 必须由一个 Google Cloud 项目签发一次，而这一步只有用户本人能做。
 * 所以这里的任务只有一个 —— **把那次准备压到最短**：
 * 三个直达链接（点开就是目标页，不用在控制台里找），两个输入框，
 * 一次粘贴。做完这一次，refresh token 就留在系统密钥环里，
 * 之后再点同步就是完整的「弹浏览器 → 授权 → 上传 → 打开文档」。
 *
 * 刻意不做的事：不内嵌任何凭据。凭据要么是用户的，要么没有 ——
 * 内嵌一份「公共」Client ID 等于让所有用户的文档都过同一个应用，
 * 而且一旦被 Google 判定滥用，所有人一起失效。
 */

import { useEffect, useRef, useState } from 'react';
import {
  ExternalLink,
  Eye,
  EyeOff,
  Key,
  Loader2,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  GOOGLE_CONSOLE_LINKS,
  saveGoogleCredentials,
  type GoogleStatus,
} from '@/core/google/api';
import { toErrorMessage } from '@/core/llm/types';

/** 向导里的一个步骤：序号 + 标题 + 说明 + 一个直达链接。 */
function Step({
  n,
  title,
  children,
  link,
  linkText,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  link: string;
  linkText: string;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink-800 text-[10px] font-semibold text-ink-300"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs font-medium text-ink-200">{title}</p>
        <p className="text-[11px] leading-relaxed text-ink-500">{children}</p>
        {/*
          用真实的 <a>：opener 插件的 open_js_links_on_click 默认为 true，
          会把这类点击交回系统浏览器 —— 在应用内的 WebView 里登 Google
          是不行的，Google 自己也会拒绝。
        */}
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-brand-400 hover:text-brand-300"
        >
          {linkText}
          <ExternalLink size={11} />
        </a>
      </div>
    </li>
  );
}

export function GoogleSetupDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  /** 保存成功。调用方接着去连接 + 上传，用户就不必再点一次。 */
  onSaved: (status: GoogleStatus) => void;
}) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  // 打开就把光标放在第一个输入框：用户多半是刚从浏览器复制了 Client ID。
  useEffect(() => {
    firstField.current?.focus();
  }, []);

  // Escape 关闭。挂在 document 上而不是面板上 —— 焦点此刻在输入框里，
  // 面板上的 onKeyDown 收不到（输入框不冒泡到它？会冒泡，但用户也可能
  // 先点了别处再按 Escape，那时焦点根本不在面板里）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0;

  const handleSave = () => {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    void saveGoogleCredentials(clientId.trim(), clientSecret.trim())
      .then((status) => {
        onSaved(status);
      })
      .catch((e: unknown) => {
        setError(toErrorMessage(e));
      })
      .finally(() => setSaving(false));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
      // 点遮罩关闭。用 mousedown 且只在遮罩自身上触发 ——
      // 面板内部的按下会冒泡到这里，用 e.target === e.currentTarget 挡掉。
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="google-setup-title"
        className="my-8 w-full max-w-xl rounded-xl border border-ink-700 bg-ink-900 shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-ink-800 px-5 py-4">
          <Key size={16} className="mt-0.5 shrink-0 text-brand-400" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 id="google-setup-title" className="text-sm font-semibold text-ink-200">
              连接 Google Docs
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
              需要一次性建一个 OAuth 客户端，大约三分钟，
              <span className="text-ink-300">只做一次</span>
              。凭据存在这台电脑的系统凭据管理器里，不会上传到任何地方。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 rounded-md p-1 text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-300"
          >
            <X size={15} />
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          <ol className="space-y-4">
            <Step
              n={1}
              title="启用 Google Drive API"
              link={GOOGLE_CONSOLE_LINKS.enableDriveApi}
              linkText="打开 Drive API 页面"
            >
              用你的 Google 账号登录后点「启用」。没有项目的话，页面上会让你先建一个，
              名字随便取（比如「简历美化」）。
            </Step>

            <Step
              n={2}
              title="配置同意屏幕"
              link={GOOGLE_CONSOLE_LINKS.consentScreen}
              linkText="打开同意屏幕设置"
            >
              用户类型选「外部」，应用名与邮箱随便填。保存后如果让你加「测试用户」，
              把自己的邮箱加进去 —— 这样就不用等 Google 审核。
            </Step>

            <Step
              n={3}
              title="创建 OAuth 客户端 ID"
              link={GOOGLE_CONSOLE_LINKS.createClient}
              linkText="打开凭据页面"
            >
              点「创建凭据 → OAuth 客户端 ID」，应用类型
              <span className="text-ink-300">必须选「桌面应用」</span>
              。创建完把 Client ID 与客户端密钥复制到下面两个框里 ——
              密钥只显示这一次，关掉页面就得重新建一个。
            </Step>
          </ol>

          <div className="space-y-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-ink-400">Client ID</span>
              <input
                ref={firstField}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                placeholder="1234567890-abcdefg.apps.googleusercontent.com"
                className="field w-full font-mono text-[11px]"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-[11px] text-ink-400">客户端密钥</span>
              <span className="relative block">
                <input
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  type={showSecret ? 'text' : 'password'}
                  placeholder="GOCSPX-…"
                  className="field w-full pr-8 font-mono text-[11px]"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((v) => !v)}
                  aria-label={showSecret ? '隐藏密钥' : '显示密钥'}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-500 transition-colors hover:text-ink-300"
                >
                  {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </span>
            </label>
          </div>

          {error ? (
            <p className="flex items-start gap-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-rose-500">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              {error}
            </p>
          ) : null}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave || saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : null}
              保存并继续
            </button>
            <p className="text-[11px] leading-relaxed text-ink-600">
              保存后浏览器会弹出 Google 的登录页，在里面点「允许」就完成了。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
