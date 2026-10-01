/**
 * 参考资料（方块 4 / 5 的产物）。
 *
 * 方块 4：粘贴板、图标、文件添加
 * 方块 5：网页 URL 添加
 *
 * 关键区分：**参考资料的归属决定它去哪**。
 *   - 归到「正文」→ 解析成 ContentUnit，成为会被排版的内容
 *   - 归到「岗位 / 补充」→ 只作为设计决策的输入，**不会**出现在成品里
 *
 * 这个区分很重要：用户导入一份别人的优秀简历当参考，
 * 那是给模型看的设计参考，绝不能被渲染进自己的成品。
 */

/** 内容在作品中的角色。 */
export type RefRole =
  /** 用户自己的正文（简历 / 求职信）。会被冻结为内容单元。 */
  | 'primary'
  /** 目标岗位资料。只影响设计决策。 */
  | 'target'
  /** 额外补充资料。只影响设计决策。 */
  | 'extra'
  /** 设计参考（如别人的简历样式）。只影响设计决策。 */
  | 'reference';

export const ROLE_LABELS: Record<RefRole, string> = {
  primary: '我的正文',
  target: '目标岗位',
  extra: '补充资料',
  reference: '设计参考',
};

export const ROLE_HINTS: Record<RefRole, string> = {
  primary: '会进入成品排版；文字不会被改动',
  target: '只用于判断风格取向，不出现在成品里',
  extra: '只用于判断风格取向，不出现在成品里',
  reference: '只看排版风格，内容不会进入成品',
};

/**
 * 资料来源。
 *
 * `image` 与其余三种有个本质区别：**它没有正文**。
 * `text` 对它只是描述（如「剪贴板图片 1」），真正的载荷在 `dataBase64` 里，
 * 最终会作为图片分段随请求发给模型。
 */
export type RefSource =
  | { kind: 'paste'; text: string }
  | { kind: 'file'; fileName: string; size: number; path?: string }
  | { kind: 'url'; url: string }
  | {
      kind: 'image';
      /** 展示用名字，如「剪贴板图片 1」「旧简历截图.png」。 */
      fileName: string;
      /** 如 `image/png`。 */
      mime: string;
      /** **不含** `data:` 前缀的纯 base64。 */
      dataBase64: string;
      /** 原图字节数。压缩后仍保留原值，用于如实告诉用户省了多少。 */
      size: number;
      /** 压缩后的字节数。与 `size` 不同时界面要说明已经压过。 */
      storedSize?: number;
    };

/** 一条参考资料。 */
export interface Reference {
  id: string;
  role: RefRole;
  source: RefSource;
  /** 抽取出来的纯文本。文件与 URL 在导入时抽取。 */
  text: string;
  /** 导入时间（毫秒）。 */
  addedAt: number;
  /** 抽取过程中的警告（如 PDF 缺字体导致乱码），需要让用户知道。 */
  warning?: string;
}

/** 文本输入模式。 */
export type TextMode = 'plain' | 'markdown';

/** 一个工作台（简历或求职信）的全部输入。 */
export interface WorkbenchInput {
  /** 方块 1：主文本。 */
  mainText: string;
  mainMode: TextMode;
  /** 方块 2：目标岗位。 */
  targetRole: string;
  targetMode: TextMode;
  /** 方块 3：补充资料。 */
  extraNotes: string;
  extraMode: TextMode;
  /** 方块 4 / 5：参考资料。 */
  references: Reference[];
  /** 功能 2：自定义风格要求。 */
  customStyle: string;
  /** 选中的预设风格 id；为 null 表示完全自定义。 */
  presetId: string | null;
}

/** 新建一个空的工作台输入。 */
export function emptyInput(): WorkbenchInput {
  return {
    mainText: '',
    mainMode: 'plain',
    targetRole: '',
    targetMode: 'plain',
    extraNotes: '',
    extraMode: 'plain',
    references: [],
    customStyle: '',
    presetId: null,
  };
}
