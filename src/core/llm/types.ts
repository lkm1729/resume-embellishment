/**
 * 供应商与模型的类型定义。
 *
 * 与 Rust 侧 `src-tauri/src/llm/types.rs` 一一对应。
 * 字段名用 camelCase —— Rust 侧统一标了 `#[serde(rename_all = "camelCase")]`。
 *
 * ⚠ 这里**没有 apiKey 字段**，这不是遗漏：
 * 密钥存在系统密钥环里，永不进入前端状态、日志或持久化。
 */

/** 接口协议。 */
export type Protocol = 'chat_completions' | 'responses';

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  chat_completions: 'Chat Completions',
  responses: 'Responses',
};

export const PROTOCOL_HINTS: Record<Protocol, string> = {
  chat_completions: '兼容性最广，绝大多数第三方与自建端点都支持',
  responses: 'OpenAI 新协议，部分兼容端点尚未实现',
};

/**
 * 思考强度档位。
 *
 * 取的是各家端点的并集，不是一个标准枚举 ——
 * `xhigh`/`max` 只有少数实现认，`none` 在另一些实现里叫 `minimal`。
 * 因此这一项**默认留空**：不填就完全不发这个参数，
 * 请求体与从前逐字一致；填了才发，风险由填的人自己承担（UI 里写清楚了）。
 */
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: '关闭思考',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
};

/**
 * 单个模型的自定义参数。
 *
 * 挂在**模型**上而不是供应商上：同一个中转站下面，
 * 各模型的能力差别往往比不同供应商之间还大
 * （一个认结构化输出、另一个不认，一个支持图片、另一个只吃文本）。
 *
 * 每个字段都可以不填，不填就是「不要替我决定」：
 *   - `temperature` / `reasoningEffort` 不填 → 不往请求里放这个参数
 *   - `structuredOutput` / `multimodal` 不填 → 跟随探测结果（三态覆盖）
 */
export interface ModelSettings {
  /** 采样温度。不填则用端点默认值。 */
  temperature?: number;
  /** 思考强度。不填则不下发该参数。 */
  reasoningEffort?: ReasoningEffort;
  /**
   * 是否支持结构化输出。
   *
   * `true` 强制启用 JSON Schema 策略（探测说不支持也照发）；
   * `false` 直接走纯文本 + 提示词内嵌 schema；
   * 不填则跟随 `Capabilities`。
   */
  structuredOutput?: boolean;
  /**
   * 是否支持多模态（图片）。
   *
   * `false` 时不再把参考图随请求下发；不填视为支持。
   */
  multimodal?: boolean;
}

/** 用户自定义的模型条目。 */
export interface ModelEntry {
  /** 实际调用时传给 API 的模型 ID。 */
  id: string;
  /** 用户可读的显示名；为空时 UI 回退显示 id。 */
  displayName?: string;
  /** 这个模型的自定义参数；为空表示全部跟随端点默认与探测结果。 */
  settings?: ModelSettings;
}

/**
 * 随请求一起下发的图片（与 Rust 侧 `ImageAttachment` 一一对应）。
 *
 * 只传 base64 而不是路径：粘贴进来的截图**根本没有文件**，
 * 而为一个内存里的位图造一个临时文件、再让后端去读，
 * 除了多一次失败机会之外没有任何好处。
 */
export interface ImageAttachment {
  /** 如 `image/png`。必须是压缩后实际的类型，不是原图的。 */
  mime: string;
  /** **不含** `data:` 前缀的纯 base64。 */
  dataBase64: string;
  /** 展示用名字，用于日志与错误提示。 */
  name?: string;
}

/** 端点能力探测结果。 */
export interface Capabilities {
  jsonSchema: boolean;
  jsonObject: boolean;
  streaming: boolean;
  listModels: boolean;
}

/** 连通性测试结果。 */
export interface ProbeResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  capabilities?: Capabilities;
  /** 毫秒时间戳。 */
  at: number;
}

/** 供应商（不含密钥）。 */
export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  protocol: Protocol;
  /** 密钥环条目名。真正的密钥不在前端。 */
  secretRef: string;
  models: ModelEntry[];
  lastProbe?: ProbeResult;
}

/** `GET /models` 返回的一项。 */
export interface ModelInfo {
  id: string;
  ownedBy?: string;
  created?: number;
}

/** 后端统一错误结构。 */
export interface CommandError {
  kind:
    | 'invalid'
    | 'not_found'
    | 'corrupt_config'
    | 'io'
    | 'no_config_dir'
    | 'no_key'
    | 'keyring_unavailable'
    | 'keyring'
    | 'llm'
    | string;
  /** 面向用户的中文说明，可能多行并含供应商原始报错。 */
  message: string;
}

/** 把后端抛出的任意错误规整为可展示文本。 */
export function toErrorMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const maybe = e as Partial<CommandError>;
    if (typeof maybe.message === 'string') return maybe.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 把后端错误规整为带 kind 的结构。 */
export function toCommandError(e: unknown): CommandError {
  if (e && typeof e === 'object') {
    const maybe = e as Partial<CommandError>;
    if (typeof maybe.message === 'string') {
      return { kind: maybe.kind ?? 'unknown', message: maybe.message };
    }
  }
  if (e instanceof Error) return { kind: 'unknown', message: e.message };
  return { kind: 'unknown', message: String(e) };
}

/** 生成一个前端本地 ID。 */
export function newProviderId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 18);
  return `p_${rand}`;
}
