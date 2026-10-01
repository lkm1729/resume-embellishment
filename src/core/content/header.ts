import type { ContentUnit } from './types';

/**
 * 简历头部抽取。
 *
 * 为什么需要它：
 * 简历前几行几乎总是「姓名 / 职位 / 手机 / 邮箱 / 城市」这种**没有板块标题**的
 * 散行。若把它们当成普通段落，模型就只能盲猜哪一行是姓名、哪一行是电话，
 * 于是排版结果常出现「姓名和电话挤在同一行」这类问题。
 *
 * 本模块只做**标注**：给这些单元补上 `meta.role`，
 * 供模型判断「这行是姓名的位置」。
 *
 * ⚠ 严格边界：**一个字都不改**。
 * 标注写在 `meta` 里，`text` 保持逐字原样。
 * 这是保真契约的硬要求 —— `meta` 是附加信息，不是替换。
 */

/** 头部行的语义角色。 */
export type HeaderRole =
  | 'name'
  | 'title'
  | 'contact'
  | 'location'
  | 'link'
  | 'summary'
  | 'unknown';

/** 中文姓名：2–4 个汉字，可能在中间带点（少数民族姓名）。 */
const CJK_NAME_RE = /^[\u4e00-\u9fa5]{2,4}(?:[·•][\u4e00-\u9fa5]{2,4})*$/;
/** 英文姓名：2–4 个单词，首字母大写。 */
const LATIN_NAME_RE = /^[A-Z][a-z]+(?:\s+[A-Z][a-z'.]+){1,3}$/;

/**
 * 判定姓名时必须排除的常见非姓名词。
 *
 * 「Senior Frontend Engineer」「现居上海」这类文本的字符形状与姓名相似
 * （短、无标点、首字母大写），但语义上明显不是姓名。
 * 先做一轮否定判断，比事后调顺序更可靠。
 */
const NOT_NAME_RE =
  /(?:现居|居住|所在|籍贯|地址|电话|邮箱|手机|微信|求职|意向|目标|应聘|名字|姓名)/i;

/** 职位词的英文形态需要按词匹配，否则 "Engineering" 里的 "engineer" 会误命中。 */
const TITLE_WORD_RE = /\b(?:engineer|developer|designer|manager|director|analyst|consultant|specialist|architect|scientist|intern|lead|head|officer|founder|president|associate|executive|administrator|coordinator|technician)s?\b/i;

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /(?:\+?86[-\s]?)?1[3-9]\d{9}|(?:\+?\d[\d\s()-]{6,}\d)/;
const URL_RE = /https?:\/\/\S+|(?:www\.)\S+|\b(?:github|gitlab|linkedin|gitee)\.com\/\S+/i;

/** 常见职位词，用于标题行识别。 */
const TITLE_KEYWORDS = [
  '工程师', '开发', '程序', '架构师', '技术专家', '研究员', '科学家',
  '产品经理', '产品', '运营', '设计', '视觉', '交互', '美术',
  '市场', '销售', '商务', '客户', '客服', '品牌', '公关',
  '经理', '总监', '主管', '组长', '负责人', '总裁', '董事', '首席执行官',
  '分析师', '顾问', '会计', '财务', '审计', '法务', '律师', '人力', 'HR',
  '教师', '教授', '医生', '护士', '编辑', '记者', '翻译', '策划',
  '实习生', '应届生', '助理', '专员', '文员', '行政',
  // 英文
  'engineer', 'developer', 'designer', 'manager', 'director', 'analyst',
  'consultant', 'specialist', 'architect', 'scientist', 'intern',
  'lead', 'head', 'officer', 'founder', 'president', 'associate',
];

/** 常见城市/地区词。 */
const LOCATION_KEYWORDS = [
  '北京', '上海', '广州', '深圳', '杭州', '南京', '成都', '武汉', '西安',
  '重庆', '天津', '苏州', '长沙', '郑州', '青岛', '厦门', '合肥', '宁波',
  '无锡', '福州', '济南', '大连', '沈阳', '昆明', '哈尔滨', '长春', '石家庄',
  '香港', '澳门', '台北', '新加坡', '东京', '纽约', '伦敦', '旧金山',
  '现居', '居住地', '所在地', '籍贯', '地址', 'location', 'based in',
];

/** 判断文本是否「看起来像姓名」。 */
function looksLikeName(text: string): boolean {
  const t = text.trim();
  // 先排除明显不是姓名的词（现居/电话/求职意向…）
  if (NOT_NAME_RE.test(t)) return false;
  return CJK_NAME_RE.test(t) || LATIN_NAME_RE.test(t);
}

/** 判断文本是否含职位关键词。 */
function looksLikeTitle(text: string): boolean {
  const lower = text.toLowerCase();
  if (TITLE_WORD_RE.test(text)) return true;
  return TITLE_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
}

/** 判断文本是否含地点关键词。 */
function looksLikeLocation(text: string): boolean {
  const lower = text.toLowerCase();
  return LOCATION_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
}

/**
 * 抽取头部角色。
 *
 * 只对**文档最前面的若干单元**生效 —— 一旦遇到第一个有意义的板块标题
 * （如「教育背景」），头部区域就结束了。这个约束让抽取不会误伤正文：
 * 工作经历里的「负责人」不会被当成头部职位。
 *
 * @param units        已解析的内容单元（按顺序）
 * @param maxScan      最多扫描多少个单元（默认 8）
 * @returns            id → role 的映射；只含被判定出角色的单元
 */
export function extractHeaderRoles(
  units: readonly ContentUnit[],
  maxScan = 8,
): Map<string, HeaderRole> {
  const roles = new Map<string, HeaderRole>();
  let nameFound = false;
  let titleFound = false;

  const limit = Math.min(units.length, maxScan);

  for (let i = 0; i < limit; i++) {
    const unit = units[i];
    if (!unit) continue;

    // 遇到板块标题即认为头部结束。
    // 注意：h1 常常就是姓名本身（Markdown 里 `# 张伟`），
    // 所以只有 level >= 2 的标题才视为板块起点。
    if (unit.kind === 'heading' && (unit.level ?? 2) >= 2) break;

    const text = unit.text;
    const hasEmail = EMAIL_RE.test(text);
    const hasPhone = PHONE_RE.test(text);
    const hasUrl = URL_RE.test(text);

    // 1. 联系方式优先级最高：含邮箱/电话/链接的行就是联系行，
    //    哪怕它同时含「北京」这种地名（`138-0000-0000 | 北京`）。
    if (hasEmail || hasPhone || hasUrl) {
      roles.set(unit.id, 'contact');
      continue;
    }

    // 2. 职位与地点先于姓名判定。
    //    理由：「Senior Frontend Engineer」「现居上海」与姓名的字符形状高度相似
    //    （短、无标点、首字母大写），先判更具体的语义角色能避免姓名规则抢走它们。
    //    姓名只取第一个，且不在职位行之后 —— 头部顺序通常是「姓名 → 职位」，
    //    一旦职位已出现，说明排序非常规，再猜姓名只会出错。
    if (!titleFound && text.length <= 40 && looksLikeTitle(text)) {
      roles.set(unit.id, 'title');
      titleFound = true;
      continue;
    }

    if (text.length <= 20 && looksLikeLocation(text)) {
      roles.set(unit.id, 'location');
      continue;
    }

    // 3. 姓名
    if (!nameFound && !titleFound && looksLikeName(text)) {
      roles.set(unit.id, 'name');
      nameFound = true;
      continue;
    }

    // 其余头部单元保持不动（可能是摘要段落），交给模型自行判断。
  }

  return roles;
}

/**
 * 把头部角色写进单元的 `meta.role`。
 *
 * 返回**新的**单元数组，原数组不变 —— 冻结的内容单元不应被就地修改。
 * `text` 与其它字段原样保留。
 */
export function annotateHeader(
  units: readonly ContentUnit[],
  maxScan = 8,
): ContentUnit[] {
  const roles = extractHeaderRoles(units, maxScan);
  if (roles.size === 0) return [...units];

  return units.map((u) => {
    const role = roles.get(u.id);
    if (!role) return u;
    return {
      ...u,
      meta: { ...(u.meta ?? {}), role },
    };
  });
}

/** 头部角色，按展示顺序排列。用于渲染层的默认徽标顺序。 */
export const HEADER_ROLE_ORDER: readonly HeaderRole[] = [
  'name',
  'title',
  'contact',
  'location',
  'link',
];
