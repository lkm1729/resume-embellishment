/**
 * Google Docs 同步的前端封装。
 *
 * 与 Rust 侧 `src-tauri/src/google.rs` 一一对应。
 * 命令名受 `lib.rs` 里 `COMMAND_NAMES` 那个测试守着。
 */

import { invoke } from '@tauri-apps/api/core';
import { toCommandError } from '@/core/llm/types';
import { isTauri } from '@/core/llm/api';

/**
 * 连接状态。
 *
 * 刻意**不含**任何密钥字段 —— 这份结构会进 React 状态、进 DevTools、
 * 进用户的截图。Rust 侧的 `GoogleStatus` 也是照这个原则设计的。
 */
export interface GoogleStatus {
  /** 两个客户端字段都填过了。 */
  configured: boolean;
  /** 已经拿过 refresh token，可以直接上传。 */
  connected: boolean;
  /** 回显给用户看「填的是哪一个」，不是密钥。 */
  clientId: string;
}

/** 一份上传成功的 Google 文档。 */
export interface GoogleDoc {
  id: string;
  name: string;
  /** 可直接打开的编辑页地址。 */
  url: string;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw {
      kind: 'no_tauri',
      message: '当前不在 Tauri 应用内运行，无法同步到 Google Docs。',
    };
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toCommandError(e);
  }
}

/**
 * 在系统默认浏览器里打开一个地址。
 *
 * 只用在上传完成后的自动跳转。界面上的普通链接直接写
 * `<a href="https://…" target="_blank">` 就行 —— opener 插件的
 * `open_js_links_on_click` 默认为 true，会接管这类点击。
 */
export const openExternal = (url: string): Promise<void> =>
  call('open_external', { url });

export const googleStatus = (): Promise<GoogleStatus> => call('google_status');

/** 保存 Client ID / Client Secret。会一并清掉旧的授权（换了身份）。 */
export const saveGoogleCredentials = (
  clientId: string,
  clientSecret: string,
): Promise<GoogleStatus> =>
  call('google_save_credentials', { clientId, clientSecret });

/** 断开：清掉长期凭据，保留客户端字段。 */
export const disconnectGoogle = (): Promise<GoogleStatus> =>
  call('google_disconnect');

/**
 * 连接：弹出系统默认浏览器让用户登录并授权。
 *
 * 这是一个**长时间**调用 —— 它会一直等到用户在浏览器里点完「允许」
 * （最多 5 分钟）。调用方要把按钮置成 busy，别让用户重复点。
 */
export const connectGoogle = (): Promise<GoogleStatus> => call('google_connect');

/**
 * 让正在等待的那次 `connectGoogle()` 立刻收手。
 *
 * 它能在 `connectGoogle()` 还挂着的时候跑，因为两条命令各自独立；
 * 等待那头会在一个轮询周期（约 120ms）内返回一个 `google_cancelled`
 * 错误 —— 取消这件事对调用方表现为「`connectGoogle()` 抛错了」，
 * 不需要另开一条成功路径。
 */
export const cancelGoogle = (): Promise<void> => call('google_cancel');

/**
 * 上传一份 .docx，返回可在 Google Docs 里打开的地址。
 *
 * 走 base64 而不是 `Uint8Array`：Tauri 的 IPC 会把字节数组展开成
 * 一个 JSON 数字数组，一份几十 KB 的 docx 会变成几十万个数字。
 */
export const uploadGoogleDocx = (
  name: string,
  docxBase64: string,
): Promise<GoogleDoc> =>
  call('google_upload_docx', { name, docxBase64 });

/**
 * 配置向导里的三个直达链接。
 *
 * 用 Google 控制台里存在了很多年的路径而不是新的
 * `console.cloud.google.com/auth/*`：旧路径会重定向到新界面，
 * 而新路径哪天再改一次就会 404。
 */
export const GOOGLE_CONSOLE_LINKS = {
  /** ① 在项目里启用 Google Drive API。 */
  enableDriveApi:
    'https://console.cloud.google.com/apis/library/drive.googleapis.com',
  /** ② 配置 OAuth 同意屏幕（外部 + 测试用户就是自己）。 */
  consentScreen: 'https://console.cloud.google.com/apis/credentials/consent',
  /** ③ 创建 OAuth 客户端 ID，类型必须选「桌面应用」。 */
  createClient: 'https://console.cloud.google.com/apis/credentials',
} as const;
