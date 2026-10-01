/**
 * Tauri 命令的前端封装。
 *
 * 所有与 Rust 侧的通信都经过本模块 —— 好处是：
 *   1. 前端组件不直接依赖 `@tauri-apps/api`，便于单测与将来替换;
 *   2. 命令名与参数形状集中一处，改名不会漏改;
 *   3. 错误在这里就规整成 `CommandError`，组件里不必重复判断。
 *
 * 注意：**API Key 只以参数形式单向传入 Rust**，
 * 不会出现在任何返回值里，也不会被写入前端持久化状态。
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  CommandError,
  ImageAttachment,
  ModelInfo,
  ProbeResult,
  Provider,
  ReasoningEffort,
} from './types';
import { toCommandError } from './types';

/**
 * 判断当前是否运行在 Tauri 环境里。
 *
 * 纯浏览器里跑（`npm run dev` 直接开页面）时没有 Tauri 注入的全局对象，
 * 此时给出可读的提示，而不是抛一个莫名其妙的错误。
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw {
      kind: 'no_tauri',
      message:
        '当前不在 Tauri 应用内运行，无法访问后端。\n' +
        '请用 `npm run tauri dev` 启动桌面应用，而不是直接打开网页。',
    } satisfies CommandError;
  }

  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toCommandError(e);
  }
}

/** 检查系统密钥环是否可用。 */
export const keyringStatus = (): Promise<void> => call('keyring_status');

/** 列出全部供应商。 */
export const listProviders = (): Promise<Provider[]> => call('list_providers');

/**
 * 新增或更新供应商。
 *
 * `apiKey` 省略或为空时**保持原有密钥不变** ——
 * 这样用户改 Base URL 或名字时不必重新输入密钥。
 */
export const saveProvider = (provider: Provider, apiKey?: string): Promise<Provider> =>
  call('save_provider', { provider, apiKey: apiKey ?? null });

/** 删除单个供应商（同时清除其密钥）。 */
export const deleteProvider = (id: string): Promise<void> => call('delete_provider', { id });

/** 批量删除。返回实际删除的数量。 */
export const deleteProviders = (ids: string[]): Promise<number> =>
  call('delete_providers', { ids });

/** 该供应商是否已配置密钥（不返回密钥内容）。 */
export const providerHasKey = (id: string): Promise<boolean> =>
  call('provider_has_key', { id });

/**
 * 拉取可用模型列表。
 *
 * `apiKey` 省略时使用已保存的密钥，便于用户不必重复粘贴。
 */
export const fetchModels = (id: string, apiKey?: string): Promise<ModelInfo[]> =>
  call('fetch_models', { id, apiKey: apiKey ?? null });

/** 供应商尚未保存时，直接用 URL + Key 试拉模型列表。 */
export const fetchModelsRaw = (baseUrl: string, apiKey: string): Promise<ModelInfo[]> =>
  call('fetch_models_raw', { baseUrl, apiKey });

/** 测试连通性。 */
export const testProvider = (
  id: string,
  modelId: string,
  apiKey?: string,
): Promise<ProbeResult> => call('test_provider', { id, modelId, apiKey: apiKey ?? null });

/** 结构化输出策略，与 Rust 侧 `OutputStrategy` 一一对应。 */
export type OutputStrategy = 'json_schema' | 'json_object' | 'text';

/** 生成请求（与 Rust 侧 `ChatRequest` 对应）。 */
export interface ChatRequestPayload {
  system: string;
  user: string;
  strategy: OutputStrategy;
  jsonSchema?: unknown;
  maxOutputTokens?: number;
  /** 图片参考。为空时不发送该字段，请求体与从前完全一致。 */
  images?: ImageAttachment[];
  /** 采样温度。不填则不下发，由端点决定。 */
  temperature?: number;
  /** 思考强度。不填则不下发 —— 不是所有端点都认这个参数。 */
  reasoningEffort?: ReasoningEffort;
}

/** 生成响应（与 Rust 侧 `ChatResponse` 对应）。 */
export interface ChatResponsePayload {
  /** 助手产出的原始文本，JSON 提取由前端负责。 */
  text: string;
  strategyUsed: string;
  /** 端点拒绝结构化参数、框架层降级时的说明。 */
  downgradeNote?: string;
  usage?: unknown;
}

/**
 * 调用模型生成内容。
 *
 * 注意这是**纯传输**：返回的是模型原始文本，
 * 提取 JSON、校验、修复轮都在 `core/design/generate.ts` 里做。
 */
export const generateDesignSpec = (
  id: string,
  modelId: string,
  request: ChatRequestPayload,
  apiKey?: string,
): Promise<ChatResponsePayload> =>
  call('generate_design_spec', {
    id,
    modelId,
    request,
    apiKey: apiKey ?? null,
  });

// ─────────────────────────── 导出 ───────────────────────────

/**
 * 把当前页面打印为矢量 PDF。
 *
 * ⚠ 调用前必须先把界面切成「导出视图」——
 * `PrintToPdfAsync` 打印的是整个 webview，
 * 界面上有什么就会被印进 PDF。
 */
export const exportPdf = (path: string): Promise<string> =>
  call('export_pdf', { path });

/** 平台导出能力。 */
export const exportSupport = (): Promise<{
  pdf: boolean;
  platform: string;
  note: string;
}> => call('export_support');

// ─────────────────────────── 网页抓取 ───────────────────────────

/** 抓取到的网页内容。 */
export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  bytes: number;
  truncated: boolean;
}

/**
 * 抓取网页的前端看门狗时长。
 *
 * Rust 侧一次抓取的上限是 25 秒（`TIMEOUT`）＋ 连接 8 秒（`CONNECT_TIMEOUT`），
 * 所以正常情况**永远**碰不到这个数。它只在后端出了问题时兜底。
 */
const FETCH_WATCHDOG_MS = 40_000;

/**
 * 给一次后端调用套一个看门狗。
 *
 * 为什么必须有：Rust 侧的命令如果 panic，`invoke` 返回的 Promise
 * **永远不会 settle** —— 既不 resolve 也不 reject。界面上的「抓取中…」
 * 就会一直转下去，用户唯一的出路是关掉整个应用。这正是
 * 「某些网页链接长时间无法抓取」的真实成因（exe 旁的 crash.log 里写着
 * `panicked at src\fetch.rs:263:27: end byte index 12 is not a char boundary`）。
 *
 * 那个 panic 已经修掉了，Rust 侧的 HTTP 请求也有超时；这里是第二道防线：
 * 将来任何新出现的 panic 或死锁，最多让用户等这么久，然后拿到一句
 * 能读懂的话，而不是无限转圈。
 *
 * ⚠ 超时**不会**取消后端已经开始的请求（Tauri 的 `invoke` 没有取消通道），
 * 它只是让界面不再空等。对「抓一个网页」这个动作来说这就够了。
 */
async function callWithWatchdog<T>(cmd: string, ms: number, args?: Record<string, unknown>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject({
        kind: 'timeout',
        message:
          `后端超过 ${Math.round(ms / 1000)} 秒没有回应，已停止等待。\n` +
          '这不代表那个网页打不开 —— 多半是后端卡住了。可以先重试一次；\n' +
          '如果每次都在同一个网址上卡住，请把它发给开发者。',
      } satisfies CommandError);
    }, ms);
  });

  try {
    return await Promise.race([call<T>(cmd, args), watchdog]);
  } finally {
    // 无论谁先完成都要清掉定时器，否则它会拖住进程退出。
    clearTimeout(timer);
  }
}

/**
 * 抓取网页正文（方块 5）。
 *
 * 返回的文字是**不可信输入**，可能夹带提示注入。
 * 渲染侧的 `verifyNoInjection` 会兜住 —— 注入最多影响版式。
 */
export const fetchUrl = (url: string): Promise<FetchedPage> =>
  callWithWatchdog('fetch_url', FETCH_WATCHDOG_MS, { url });

// ─────────────────────────── 系统字体 ───────────────────────────

/**
 * 本机已安装的**字体族**名（方块 7 的自定义字体选择器）。
 *
 * 返回的是字体族而不是字体全名：后端走 GDI 的 `EnumFontFamiliesExW`，
 * 结果与系统字体设置面板一致。查注册表会混进 `Arial Bold` 这类样式变体，
 * 而它在 CSS 里匹配不到任何字体族，会**静默回退** ——
 * 那正是「让用户自己选字体」这件事要避免的结果。详见 `src-tauri/src/fonts.rs`。
 *
 * 刻意不套 `callWithWatchdog`：这个调用不碰网络，
 * 几百个族的枚举是毫秒级的。真要卡住那是系统级故障，等多久都一样。
 */
export const listSystemFonts = (): Promise<string[]> => call('list_system_fonts');
