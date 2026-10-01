/**
 * 「同步到 Google Docs」按钮。
 *
 * 它是 PDF / PNG / Word 之外的**第四条出口**，但和前三个不是一回事：
 * 前三个都要用户先挑一个存放位置，这一个的目标在云端，
 * 所以它不走导出 store 的 `run(type, format, …)`，而是自己一条通路
 * （`core/google/sync.ts`）。
 *
 * 一次点击要做完三件事，顺序不能换：
 *   ① 没有客户端凭据 → 先弹配置向导（做完自动往下走）
 *   ② 没有 refresh token → 连接（弹出系统默认浏览器让用户授权）
 *   ③ 上传 → 在系统默认浏览器里打开刚生成的 Google 文档
 *
 * 第 ② 步是**长时间的**：它会一直等到用户在浏览器里点完「允许」，
 * 最多五分钟。所以按钮必须置成 busy，不能让用户以为没反应而重复点。
 *
 * ⚠ 保真度：上传的是同一份 `.docx`（走 `buildDocx`），所以 Word 的两个缺口
 * 在这里同样成立 —— 分栏会变单栏，强调条与圆角不还原。
 * 调用方（ExportButtons）已经在外面写过一次这句说明，这里不重复。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, TriangleAlert, Upload } from 'lucide-react';
import type { ContentUnit } from '@/core/content/types';
import type { DesignSpec } from '@/core/design/spec';
import {
  cancelGoogle,
  connectGoogle,
  disconnectGoogle,
  googleStatus,
  openExternal,
  type GoogleDoc,
  type GoogleStatus,
} from '@/core/google/api';
import { syncToGoogleDocs } from '@/core/google/sync';
import { toErrorMessage } from '@/core/llm/types';
import { GoogleSetupDialog } from './GoogleSetupDialog';

/** 正在进行中的阶段。`null` 表示空闲（或者还在问状态）。 */
type Phase = 'connecting' | 'uploading';

export function GoogleDocsBar({
  units,
  spec,
  baseName,
}: {
  units: readonly ContentUnit[];
  spec: DesignSpec;
  baseName: string;
}) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<GoogleDoc | null>(null);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);

  /**
   * `busy` 的同步副本。
   *
   * 只用 React state 挡不住连点：`setBusy(true)` 要到下一次渲染才生效，
   * 而 `handleSync` 在 `await googleStatus()` 上至少停一个来回 —— 这中间
   * 第二次点击读到的 `busy` 还是 false。那一次点击会另起一遍授权，
   * 用户看到两个同意页，云端也多出一份文档。
   */
  const busyRef = useRef(false);

  /**
   * 最近一次渲染拿到的文档。
   *
   * 上传前要读的是**此刻**的正文，不是按下按钮那一刻的。第 ② 步可能
   * 在浏览器里耗上几分钟，用户回来接着改两行是完全正常的 —— 用 props
   * 闭包会把那两行悄悄丢掉，而界面上没有任何迹象。
   */
  const latest = useRef({ units, spec, baseName });
  latest.current = { units, spec, baseName };

  useEffect(() => {
    let alive = true;
    void googleStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {
        // 读不到状态不阻塞用户：按下按钮时还会再问一次。
        if (alive) setStatus(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 上传。抽出来是因为它有两条来路：直接点按钮，
   * 以及「刚在向导里填完凭据」之后自动继续。
   */
  const upload = useCallback(async () => {
    setPhase('uploading');
    try {
      const created = await syncToGoogleDocs(latest.current);
      setDoc(created);
      try {
        await openExternal(created.url);
        setOpened(true);
      } catch {
        // 打开失败不算上传失败：文档已经在云端了，界面上留了链接。
        // 但也不能说「已在浏览器里打开」—— 那句话要是假的，
        // 用户会以为文档没上传成功。
        setOpened(false);
      }
    } finally {
      setPhase(null);
    }
  }, []);

  const run = (configuredOnly = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setDoc(null);
    setOpened(false);

    void (async () => {
      try {
        // 每次点击都重新问一次状态：用户可能刚在别处断开或换过凭据。
        const current = await googleStatus();
        setStatus(current);

        if (!current.configured) {
          setSetupOpen(true);
          return;
        }
        if (configuredOnly) return;

        if (!current.connected) {
          setPhase('connecting');
          const connected = await connectGoogle();
          setStatus(connected);
        }

        await upload();
      } catch (e) {
        setError(toErrorMessage(e));
      } finally {
        busyRef.current = false;
        setBusy(false);
        setPhase(null);
      }
    })();
  };

  const handleSync = () => run();

  /**
   * 取消等待授权。
   *
   * 只把旗子放倒，不去动界面状态：等在那边的 `connectGoogle()` 会在
   * 一个轮询周期内抛错，上面那段 `finally` 会统一收尾。这样「取消」
   * 和「超时」走的是同一条路径，不会分叉出第二种结束方式。
   */
  const handleCancel = () => {
    void cancelGoogle().catch(() => undefined);
  };

  const handleDisconnect = () => {
    setError(null);
    setDoc(null);
    void disconnectGoogle()
      .then(setStatus)
      .catch((e: unknown) => setError(toErrorMessage(e)));
  };

  const label =
    phase === 'connecting'
      ? '等待浏览器里完成授权…'
      : phase === 'uploading'
        ? '正在上传…'
        : status && !status.configured
          ? '同步到 Google Docs'
          : status && !status.connected
            ? '连接并同步到 Google Docs'
            : '同步到 Google Docs';

  return (
    <>
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-ink-400">
            <Upload size={13} />
            Google Docs
          </span>

          <button
            type="button"
            onClick={handleSync}
            disabled={busy}
            title="把这份文档上传成一份 Google 文档，并在浏览器里打开它。第一次用需要先花三分钟建一个 OAuth 客户端。"
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {label}
          </button>

          {status?.configured ? (
            <>
              <button
                type="button"
                onClick={() => setSetupOpen(true)}
                disabled={busy}
                className="text-[11px] text-ink-600 transition-colors hover:text-ink-400 disabled:opacity-40"
              >
                设置
              </button>
              {status.connected ? (
                <button
                  type="button"
                  onClick={handleDisconnect}
                  disabled={busy}
                  className="text-[11px] text-ink-600 transition-colors hover:text-ink-400 disabled:opacity-40"
                >
                  断开
                </button>
              ) : null}
            </>
          ) : null}

          {/*
            等回调最长五分钟，期间其它控件都是锁着的。没有这个出口，
            用户一旦在浏览器里改主意，整条工具栏就要陪他等到底。
          */}
          {phase === 'connecting' ? (
            <button
              type="button"
              onClick={handleCancel}
              className="text-[11px] text-ink-600 transition-colors hover:text-ink-400"
            >
              取消等待
            </button>
          ) : null}
        </div>

        {doc ? (
          <p className="flex items-start gap-1.5 break-all text-[11px] leading-relaxed text-teal-500">
            <Check size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              已同步到 Google Docs：
              <a
                href={doc.url}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted underline-offset-2 hover:text-teal-400"
              >
                {doc.name}
              </a>
              {opened ? '（已在浏览器里打开）' : '（浏览器没有自动打开，点上面的链接就能看）'}
            </span>
          </p>
        ) : null}

        {error ? (
          <p className="flex items-start gap-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-rose-500">
            <TriangleAlert size={12} className="mt-0.5 shrink-0" />
            {error}
          </p>
        ) : null}

        {status && !status.configured && !error ? (
          <p className="text-[11px] leading-relaxed text-ink-600">
            第一次用需要先建一个 OAuth 客户端（点按钮会告诉你每一步点哪里，大约三分钟，只做一次）。
          </p>
        ) : null}
      </div>

      {setupOpen ? (
        <GoogleSetupDialog
          onClose={() => setSetupOpen(false)}
          onSaved={(saved) => {
            setSetupOpen(false);
            setStatus(saved);
            // 凭据刚填完，直接往下走：连接 + 上传。
            // 让用户再点一次同一个按钮是没有意义的仪式。
            void (async () => {
              try {
                setPhase('connecting');
                const connected = await connectGoogle();
                setStatus(connected);
                await upload();
              } catch (e) {
                setError(toErrorMessage(e));
                setPhase(null);
              }
            })();
          }}
        />
      ) : null}
    </>
  );
}
