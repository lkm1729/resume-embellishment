import type { HeaderRole } from './header';

/**
 * 内容单元的类型定义。
 *
 * ⚠ 这个文件是**从构建产物反向重建**的：它只有类型、没有任何运行时导出，
 * 于是被打包器整份擦除，源码 map 里也就没有它。字段形状由全部使用方反推。
 *
 * 保真契约在类型层面就写死了：`text` 是**唯一**能承载用户文字的字段，
 * 而它只由解析器写入 —— 设计规格（DesignSpec）里没有任何字段能放正文，
 * 模型只能引用 `id`。这是类型系统层面的保证，不是事后校验。
 */

/**
 * 单元的语义类型。
 *
 * - `heading`   板块标题（Markdown `#`、`【工作经历】`、或纯文本里的常见板块名）
 * - `paragraph` 普通段落
 * - `listItem`  列表项（项目符号已被剥离，列表层级记在 `level`）
 * - `date`      日期行（`2020.03 - 2023.06` 这类）
 * - `contact`   联系方式行（邮箱 / 电话 / 链接）
 * - `meta`      代码块或表格——原文语义上不是正文，但字符仍逐字保留
 */
export type UnitKind = 'heading' | 'paragraph' | 'listItem' | 'date' | 'contact' | 'meta';

/**
 * 附加标注**只放这里**。
 *
 * 为什么不写进 `text`：`text` 的逐字保真由 `hashUnits()` 守着，
 * 任何改写都会让内容哈希变化、让历史回滚失效。头部分析的结论是
 * 「这行大概是姓名」这类**附加信息**，不是替换。
 */
export interface UnitMeta {
  /** 由 `annotateHeader()` 写入的头部语义角色。 */
  role?: HeaderRole;
}

/** 一个冻结的内容单元。 */
export interface ContentUnit {
  /** 稳定 ID，形如 `u0001`；模型只能通过它引用正文。 */
  id: string;
  kind: UnitKind;
  /** 所属板块名；标题行之前的单元归入「基本信息」。 */
  section: string;
  /** 用户原文（含行内 Markdown 语法），逐字保真。 */
  text: string;
  /** 标题层级或列表嵌套深度；不适用时缺省。 */
  level?: number;
  /** 附加标注，见 `UnitMeta`。 */
  meta?: UnitMeta;
}

/** 输入模式：纯文本或 Markdown。 */
export type ParseMode = 'plain' | 'markdown';

/** 解析结果：内容单元 + 冻结哈希 + 板块清单。 */
export interface ParsedDocument {
  units: ContentUnit[];
  /** `hashUnits(units)` 的 SHA-256，用于历史去重与回滚校验。 */
  contentHash: string;
  /** 按出现顺序去重的板块名列表。 */
  sections: string[];
  mode: ParseMode;
}
