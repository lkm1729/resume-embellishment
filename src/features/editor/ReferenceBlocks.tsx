/**
 * 方块 4：粘贴板 / 文件 / 图片添加参考资料。
 * 方块 5：网页 URL 添加参考资料。
 *
 * ═══════════════════════════════════════════════════════════════
 *  这两块最关键的设计是**归属选择**。
 *
 *  用户可能导入自己的旧简历段落（应当进入成品），
 *  也可能导入别人的优秀简历当样式参考（绝不能进入成品）。
 *  同一个导入动作，两种截然不同的去向。
 *
 *  所以每条参考资料都必须显式标注归属，且默认值取最安全的那一个：
 *  **默认"设计参考"**（不进成品）。
 *  宁可让用户多勾一次，也不能因为默认值把别人的文字混进他的成品。
 *  归属在**添加时**就要能选 —— 事后改是补救，事前选才是正常路径。
 * ═══════════════════════════════════════════════════════════════
 */

import { useRef, useState } from 'react';
import {
  ClipboardPaste,
  FileUp,
  Globe,
  ImagePlus,
  Loader2,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import type { DocType } from '@/core/store/workbench';
import { newReferenceId, useWorkbenchStore } from '@/core/store/workbench';
import type { RefRole, RefSource, Reference } from '@/core/content/reference';
import { ROLE_HINTS, ROLE_LABELS } from '@/core/content/reference';
import { ACCEPT_ATTR, detectFileKind, readReferenceFile } from '@/core/content/file-import';
import {
  IMAGE_ACCEPT_ATTR,
  formatBytes,
  pickImageFiles,
  prepareImage,
} from '@/core/content/image-import';
import * as api from '@/core/llm/api';
import { toCommandError } from '@/core/llm/types';
import { InputBlock } from './InputBlock';

/** 资料来源的种类。列表按它分流，避免一块显示另一块的条目。 */
type SourceKind = RefSource['kind'];

/** 方块 4 管这些来源；图片也算在内 —— 它就是从剪贴板来的。 */
const BLOCK4_KINDS: readonly SourceKind[] = ['paste', 'file', 'image'];

/** 方块 5 只管网址。 */
const BLOCK5_KINDS: readonly SourceKind[] = ['url'];

/** 归属选择器。把"会不会进成品"直接写在选项上。 */
function RolePicker({
  role,
  onChange,
  size = 'sm',
}: {
  role: RefRole;
  onChange: (r: RefRole) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {(Object.keys(ROLE_LABELS) as RefRole[]).map((r) => {
        const active = r === role;
        const enters = r === 'primary';
        return (
          <button
            key={r}
            type="button"
            onClick={() => onChange(r)}
            title={ROLE_HINTS[r]}
            className={[
              'rounded transition-colors',
              size === 'md' ? 'px-2 py-1 text-[11px]' : 'px-1.5 py-0.5 text-[10px]',
              active
                ? enters
                  ? 'bg-brand-500 text-on-accent'
                  : 'bg-ink-700 text-ink-200'
                : 'text-ink-600 hover:bg-ink-800 hover:text-ink-400',
            ].join(' ')}
          >
            {ROLE_LABELS[r]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 添加前的归属选择。
 *
 * 单独抽出来是因为两个方块的行为必须一致 ——
 * 用户在这里建立的预期是「我选了什么，加进去就是什么」。
 */
function AddRoleBar({
  role,
  onChange,
  hint,
}: {
  role: RefRole;
  onChange: (r: RefRole) => void;
  hint: string;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-[11px] text-ink-600">加入时的归属：</span>
      <RolePicker role={role} onChange={onChange} size="md" />
      <span className="text-[10px] text-ink-600">{hint}</span>
    </div>
  );
}

/** 一条参考资料的展示行。 */
function ReferenceRow({
  ref: r,
  onRoleChange,
  onRemove,
}: {
  ref: Reference;
  onRoleChange: (role: RefRole) => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const enters = r.role === 'primary';
  const isImage = r.source.kind === 'image';

  const sourceLabel =
    r.source.kind === 'paste'
      ? '粘贴的文字'
      : r.source.kind === 'file'
        ? r.source.fileName
        : r.source.kind === 'url'
          ? r.source.url
          : r.source.fileName;

  const preview = r.text.length > 120 ? `${r.text.slice(0, 120)}…` : r.text;

  return (
    <li className="rounded-lg border border-ink-800 bg-ink-950/50 p-2.5">
      <div className="flex items-start gap-2">
        {/* 图片给出缩略图：用户贴了三张图之后，光看名字分不清哪张是哪张。 */}
        {isImage && r.source.kind === 'image' ? (
          <img
            src={`data:${r.source.mime};base64,${r.source.dataBase64}`}
            alt={r.source.fileName}
            className="h-14 w-14 shrink-0 rounded border border-ink-800 object-cover"
          />
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={[
                'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                enters ? 'bg-brand-500/15 text-brand-400' : 'bg-ink-800 text-ink-400',
              ].join(' ')}
            >
              {enters ? '进入成品' : isImage ? '设计参考图' : '仅作参考'}
            </span>
            <span className="min-w-0 truncate text-[11px] text-ink-300" title={sourceLabel}>
              {sourceLabel}
            </span>
            <span className="shrink-0 text-[10px] text-ink-600">
              {isImage && r.source.kind === 'image'
                ? formatBytes(r.source.storedSize ?? r.source.size)
                : `${r.text.length} 字`}
            </span>
          </div>

          {/* 图片没有正文可展开 —— `text` 只是名字，展开它没有意义。 */}
          {isImage ? (
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
              这张图会随请求一起发给模型，作为版式与配色的参考。
            </p>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1.5 block w-full text-left text-[11px] leading-relaxed text-ink-400 hover:text-ink-300"
            >
              {expanded ? r.text : preview}
            </button>
          )}

          {r.warning ? (
            <p className="mt-1.5 flex items-start gap-1 text-[10px] text-warn-400">
              <TriangleAlert size={10} className="mt-0.5 shrink-0" />
              {r.warning}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-1 text-ink-600 transition-colors hover:bg-ink-800 hover:text-rose-500"
            aria-label="移除这条参考资料"
          >
            <Trash2 size={13} />
          </button>
          {/* 图片永远是参考图，「进入成品」对它没有意义，就不摆这个选项了。 */}
          {isImage ? null : <RolePicker role={r.role} onChange={onRoleChange} />}
        </div>
      </div>
    </li>
  );
}

/**
 * 两个方块共用的列表部分。
 *
 * `kinds` 是必需的，不是可选优化：
 * 不按来源分流时，方块 5 抓来的网页会出现在方块 4 的列表里，
 * 用户会以为"我只是贴了个网址，怎么粘贴板里多出一条"。
 */
function ReferenceList({ type, kinds }: { type: DocType; kinds: readonly SourceKind[] }) {
  const all = useWorkbenchStore((s) => s.inputs[type].references);
  const updateReference = useWorkbenchStore((s) => s.updateReference);
  const removeReference = useWorkbenchStore((s) => s.removeReference);

  const refs = all.filter((r) => kinds.includes(r.source.kind));

  if (refs.length === 0) return null;

  const entering = refs.filter((r) => r.role === 'primary').length;
  // 图片不参与「进入成品」的计数 —— 它从来不进成品，列进去只会让人困惑。
  const images = refs.filter((r) => r.source.kind === 'image').length;

  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-ink-600">
        <span>共 {refs.length} 条</span>
        <span>·</span>
        <span className={entering > 0 ? 'text-brand-400' : ''}>
          {entering} 条会进入成品
        </span>
        {images > 0 ? (
          <>
            <span>·</span>
            <span>{images} 张参考图</span>
          </>
        ) : null}
      </div>
      <ul className="space-y-2">
        {refs.map((r) => (
          <ReferenceRow
            key={r.id}
            ref={r}
            onRoleChange={(role) => updateReference(type, r.id, { role })}
            onRemove={() => removeReference(type, r.id)}
          />
        ))}
      </ul>
      <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-ink-600">
        <input
          type="checkbox"
          className="accent-brand-500"
          checked={entering === 0}
          onChange={() => {
            // 一键把所有条目设为"不进成品" —— 这是最安全的批量操作方向，
            // 反向操作（全设为进入成品）风险太高，不提供。
            for (const r of refs) updateReference(type, r.id, { role: 'reference' });
          }}
        />
        全部设为"仅作参考"（不进入成品）
      </label>
    </div>
  );
}

// ─────────────────────────── 方块 4 ───────────────────────────

export function PasteFileBlock({ type }: { type: DocType }) {
  const addReference = useWorkbenchStore((s) => s.addReference);
  const [pasteText, setPasteText] = useState('');
  const [role, setRole] = useState<RefRole>('reference');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  const handleAddPaste = () => {
    const text = pasteText.trim();
    if (text.length === 0) return;
    addReference(type, {
      id: newReferenceId(),
      role,
      source: { kind: 'paste', text },
      text,
      addedAt: Date.now(),
    });
    setPasteText('');
  };

  /**
   * 图片导入。
   *
   * 与文字资料不同，图片**不解析正文**：它整张随请求发给模型当设计参考。
   * 因此这里的失败提示要对准图片特有的问题（格式、太大、读不出），
   * 而不是复用文件的"里面没有文字"。
   */
  const handleImages = async (files: readonly File[]) => {
    if (files.length === 0) return;
    setError(null);
    setBusy(true);

    const added: string[] = [];
    const failed: string[] = [];
    // 序号接着已有图片往后排，避免多批导入都叫"剪贴板图片 1"。
    let index =
      useWorkbenchStore
        .getState()
        .inputs[type].references.filter((r) => r.source.kind === 'image').length + 1;

    for (const file of files) {
      try {
        const img = await prepareImage(file, index);
        addReference(type, {
          id: newReferenceId(),
          // 图片永远只是参考图 —— 它没有正文，不可能"进入成品"。
          role: 'reference',
          source: {
            kind: 'image',
            fileName: img.fileName,
            mime: img.mime,
            dataBase64: img.dataBase64,
            size: img.size,
            storedSize: img.storedSize,
          },
          text: img.fileName,
          addedAt: Date.now(),
          ...(img.warning ? { warning: img.warning } : {}),
        });
        added.push(`${img.fileName}（${formatBytes(img.storedSize)}）`);
        index++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push(msg);
      }
    }

    if (failed.length > 0) setError(failed.join('\n'));
    if (added.length > 0) {
      setNotice(`已加入 ${added.length} 张图片：${added.join('、')} —— 会随请求发给模型作设计参考`);
    }

    setBusy(false);
    if (imageInput.current) imageInput.current.value = '';
  };

  /**
   * 剪贴板读取按钮。
   *
   * ⚠ 这条路依赖 `navigator.clipboard.read()`，而它需要用户授权，
   * 且部分 WebView 版本直接不实现。所以失败时必须说清"可以改用 Ctrl+V"，
   * 而不是丢一个英文异常让用户以为功能坏了 —— 快捷键那条路总是通的。
   */
  const handleClipboardImage = async () => {
    setError(null);
    setNotice(null);

    const clip = navigator.clipboard;
    if (!clip || typeof clip.read !== 'function') {
      setError(
        '这个界面不支持直接读取剪贴板。请把图片复制后，在本方块内的输入框里按 Ctrl+V 粘贴。',
      );
      return;
    }

    setBusy(true);
    try {
      const items = await clip.read();
      const files: File[] = [];
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        files.push(new File([blob], `剪贴板图片.${type.split('/')[1] ?? 'png'}`, { type }));
      }

      if (files.length === 0) {
        setError('剪贴板里没有图片。请先复制一张图片，或改用「选择图片」。');
        return;
      }
      await handleImages(files);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        `读剪贴板失败：${msg}\n可以改用 Ctrl+V 直接在输入框里粘贴，或点「选择图片」。`,
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * 文件导入。
   *
   * 支持 .txt / .md（直接读文本）、.pdf（pdfjs 抽取）、.docx（解包抽取）。
   *
   * 每种格式的失败方式都不一样，因此**必须分别给出可操作的提示**：
   * 扫描版 PDF 要告诉用户去用 OCR，加密的要告诉它解不开，
   * 而不是笼统地说一句"导入失败"。
   */
  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);

    const added: string[] = [];
    const failed: string[] = [];

    for (const file of Array.from(files)) {
      const kind = detectFileKind(file);

      try {
        const result = await readReferenceFile(file, kind);
        if (result.text.trim().length === 0) {
          failed.push(`「${file.name}」里没有可用的文字。`);
          continue;
        }
        addReference(type, {
          id: newReferenceId(),
          role,
          source: { kind: 'file', fileName: file.name, size: file.size },
          text: result.text,
          addedAt: Date.now(),
          ...(result.warning ? { warning: result.warning } : {}),
        });
        added.push(file.name);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push(`「${file.name}」${msg}`);
      }
    }

    if (failed.length > 0) setError(failed.join('\n'));
    if (added.length > 0) setNotice(`已导入 ${added.length} 个文件：${added.join('、')}`);

    setBusy(false);
    if (fileInput.current) fileInput.current.value = '';
  };

  /** 在输入框里粘贴时，先看剪贴板里有没有图片。 */
  const handlePaste = (e: React.ClipboardEvent) => {
    const images = pickImageFiles(e.clipboardData);
    if (images.length === 0) return; // 纯文字：走 textarea 自己的默认行为
    e.preventDefault();
    void handleImages(images);
  };

  return (
    <InputBlock
      index={4}
      title="粘贴板 / 文件"
      hint="粘贴文字、粘贴或选择图片（截图、别人的简历排版）、选择文件（.txt / .md / .pdf / .docx）。文字资料每条都要选归属 —— 只有「我的正文」才会进入成品；图片一律只作设计参考。"
    >
      <textarea
        className="field min-h-[80px] resize-y text-[13px] leading-relaxed"
        placeholder="在这里粘贴任意文字（自己的旧简历段落、别人的优秀范例、岗位描述…）；也可以直接按 Ctrl+V 粘贴截图。"
        value={pasteText}
        onChange={(e) => setPasteText(e.target.value)}
        onPaste={handlePaste}
      />

      <AddRoleBar
        role={role}
        onChange={setRole}
        hint={role === 'primary' ? '会进入成品' : '只给模型看，不进成品'}
      />

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleAddPaste}
          disabled={pasteText.trim().length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 transition-colors hover:bg-ink-800 disabled:opacity-40"
        >
          <ClipboardPaste size={13} />
          添加文字
        </button>
        <button
          type="button"
          onClick={() => void handleClipboardImage()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 transition-colors hover:bg-ink-800 disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />}
          {busy ? '处理中…' : '粘贴图片'}
        </button>
        <button
          type="button"
          onClick={() => imageInput.current?.click()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 transition-colors hover:bg-ink-800 disabled:opacity-40"
        >
          <ImagePlus size={13} />
          选择图片
        </button>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 transition-colors hover:bg-ink-800 disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />}
          选择文件
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
        <input
          ref={imageInput}
          type="file"
          multiple
          accept={IMAGE_ACCEPT_ATTR}
          className="hidden"
          onChange={(e) =>
            void handleImages(e.target.files ? Array.from(e.target.files) : [])
          }
        />
      </div>

      {notice ? (
        <p className="mt-2 text-[11px] leading-relaxed text-teal-500">{notice}</p>
      ) : null}

      {error ? (
        <p className="mt-2 flex items-start gap-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-rose-500">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}

      <ReferenceList type={type} kinds={BLOCK4_KINDS} />
    </InputBlock>
  );
}

// ─────────────────────────── 方块 5 ───────────────────────────

export function UrlBlock({ type }: { type: DocType }) {
  const addReference = useWorkbenchStore((s) => s.addReference);
  const [url, setUrl] = useState('');
  const [role, setRole] = useState<RefRole>('reference');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * 抓取网页正文。
   *
   * 两件事必须如实告知用户：
   *   1. 抓来的文字**未经审阅**，可能夹带提示注入 ——
   *      但注入最多影响版式，无法往成品里塞字（渲染侧有比对兜底）；
   *   2. 抽取是启发式的，可能夹带少量导航文字，用户可以自己删。
   */
  const handleAdd = async () => {
    const target = url.trim();
    if (target.length === 0) return;

    if (!/^https?:\/\//i.test(target)) {
      setError('请输入完整网址，以 http:// 或 https:// 开头。');
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const page = await api.fetchUrl(target);

      if (page.text.trim().length === 0) {
        // 抓取本身成功了，只是没文字可提 —— 几乎都是纯前端渲染的页面
        // （React / Vue 单页应用：源码里只有一个空壳，文字要等 JavaScript 跑完才有）。
        // 直接指向截图通路，否则用户会以为是我们坏了。
        setError(
          '这个页面靠 JavaScript 渲染，抓不到正文。\n' +
            '可以改用截图：把页面截下来，在方块 4 里按 Ctrl+V 粘贴，模型照样能看懂版式与配色。',
        );
        return;
      }

      // 抓到了，但少得可疑 —— 多半也是单页应用，只漏出来几个导航标签。
      // 不拦着不让加（短页面是存在的），但要提醒一句，否则用户会以为
      // 参考资料已经生效、只是模型没理它。
      const thin = page.text.trim().length < 200;

      addReference(type, {
        id: newReferenceId(),
        role,
        source: { kind: 'url', url: page.url },
        text: page.text,
        addedAt: Date.now(),
        ...(page.truncated
          ? { warning: '页面内容过长，已截断（仅保留了前一部分）' }
          : thin
            ? { warning: '抓到的文字很少。这个页面可能靠 JavaScript 渲染，正文没被抽出来 —— 必要时可以改用截图。' }
            : {}),
      });

      setUrl('');
      setNotice(
        `已抓取${page.title ? `「${page.title}」` : ''} ${page.text.length} 字` +
          (page.truncated ? '（内容过长已截断）' : thin ? '（偏少，可能是纯前端渲染）' : ''),
      );
    } catch (e) {
      const err = toCommandError(e);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <InputBlock
      index={5}
      title="网页 URL"
      hint="从网址抓取正文作为参考资料。抓来的内容需要标注归属，且会经过注入检测。"
    >
      <div className="flex gap-2">
        <input
          className="field font-mono text-xs"
          placeholder="https://example.com/my-portfolio"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) void handleAdd();
          }}
          disabled={busy}
        />
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={busy || url.trim().length === 0}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-2 text-xs text-ink-300 transition-colors hover:bg-ink-800 disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Globe size={13} />}
          {busy ? '抓取中…' : '抓取'}
        </button>
      </div>

      <AddRoleBar
        role={role}
        onChange={setRole}
        hint={role === 'primary' ? '会进入成品' : '只给模型看，不进成品'}
      />

      {notice ? <p className="mt-2 text-[11px] text-teal-500">{notice}</p> : null}

      {error ? (
        <p className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-rose-500">
          {error}
        </p>
      ) : null}

      <p className="mt-2 text-[11px] leading-relaxed text-ink-600">
        抓来的网页文字可能夹带恶意指令（提示注入）。系统会逐字符比对产物与原文，
        多出来的文字会被检出并拦截 —— 注入最多影响版式，无法往你的成品里塞字。
        抽取是启发式的，可能带进少量导航文字，可自行删改。
      </p>

      <ReferenceList type={type} kinds={BLOCK5_KINDS} />
    </InputBlock>
  );
}
