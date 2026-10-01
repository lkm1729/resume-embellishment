/**
 * 预设设计风格库。
 *
 * 对应需求「每个板块功能 1/2：预设设计风格 + 自定义风格文本输入」。
 *
 * 设计原则：**预设给的是「方向」，不是「成品样式」**。
 *
 * 为什么不直接把预设写成完整 DesignSpec：
 * 用户的简历板块结构千差万别（有的有「实习经历」，有的没有），
 * 写死 spec 会因为引用不存在的板块而校验失败。
 * 所以预设只描述**审美取向**，由模型结合真实板块结构生成最终 spec。
 *
 * `brief` 是要拼进 prompt 的自然语言说明；
 * `hints` 是给 UI 展示的要点，让用户知道选这个风格会发生什么。
 */

import type { DocType } from '@/core/store/workbench';

export interface DesignPreset {
  id: string;
  /** 风格名，如"金融"。 */
  name: string;
  /** 一句话说明，给用户看。 */
  tagline: string;
  /** 视觉要点，给用户看（3–5 条）。 */
  hints: readonly string[];
  /** 拼进 prompt 的风格描述。 */
  brief: string;
  /**
   * 选中该预设时预填到「自定义风格」输入框的起点文本。
   * 为 undefined 表示不预填（保留用户已写的内容）。
   */
  customSeed?: string;
  /** 适用板块。求职信与简历的合适风格并不相同。 */
  appliesTo: readonly DocType[];
}

export const PRESETS: readonly DesignPreset[] = [
  {
    id: 'finance',
    name: '金融',
    tagline: '克制、精确、可信。让数字说话，不让装饰说话。',
    hints: [
      '深蓝／墨黑主色 + 低饱和灰阶，强调色只用在标题分隔线',
      '衬线或中性无衬线字体，字号层级差距小（专业感来自秩序而非对比）',
      '信息密度偏高，允许两栏；大量使用对齐的日期与机构名',
      '无圆角、无阴影、无渐变；分隔线细而规整',
    ],
    brief:
      '风格取向：金融机构（投行、券商、银行、审计、咨询）。'
      + '整体克制、精确、可信，第一眼传达"严谨"。'
      + '配色以深藏青（#1B2A4A 附近）或墨黑为主色，中灰为辅助，'
      + '强调色饱和度低且只用于板块标题的分隔线或小色块，不可大面积铺色。'
      + '字体选衬线（如 Cambria / Times New Roman）或无衬线中性体（如 Calibri），'
      + '标题与正文的字号差距保持克制（h1 不超过正文的 2 倍）。'
      + '信息密度取 balanced 或 compact，允许单栏为主、局部两栏对齐日期。'
      + '规则线用 thin 或 double，cornerRadius 为 0。'
      + '禁止圆角、阴影、渐变与任何装饰性图形 —— 专业感来自对齐与留白的一致性。',
    appliesTo: ['resume', 'cover-letter'],
  },
  {
    id: 'tech',
    name: '创新科技',
    tagline: '清晰、有节奏、带一点冷色的锐利。',
    hints: [
      '冷色系（靛蓝／青绿）+ 高对比白底，强调色可以稍亮',
      '几何无衬线字体，字重对比明显（标题 bold，正文 normal）',
      '板块标题常配小色块或短色条，形成扫描节奏',
      '允许两栏与中等圆角；可用极淡的分区底色',
    ],
    brief:
      '风格取向：互联网、软件开发、AI、硬件创业公司。'
      + '传达"清晰、有工程感、有节奏"。'
      + '配色以冷色为主：靛蓝（#4F46E5 附近）或青绿（#0D9488 附近）作强调色，'
      + '正文用近黑灰（#1F2937），底色可以带极淡的冷灰分区（#F8FAFC）。'
      + '字体用几何无衬线（Segoe UI / Calibri），标题 bold、正文 normal，字重对比明确。'
      + '板块标题配短色条（accent-bar）或小色块，让视线能快速扫描定位。'
      + '密度取 balanced，允许局部两栏（技能／语言这类短项并排）。'
      + 'cornerRadius 可用 4–8，少量圆角让界面轻盈；不使用阴影与渐变。',
    appliesTo: ['resume', 'cover-letter'],
  },
  {
    id: 'literary',
    name: '文学',
    tagline: '留白充裕，字体本身即装饰。',
    hints: [
      '暖中性色（米白／暖灰）+ 极低调的暖褐或暗红强调',
      '衬线字体为主，字号层级靠留白而非大小拉开',
      '密度偏低（airy），行高宽松，段落间距大',
      '几乎不用线条与色块；长横线或居中标题已足够',
    ],
    brief:
      '风格取向：出版、编辑、媒体、文化机构、学术人文。'
      + '传达"从容、有文字修养"。'
      + '配色取暖中性调：正文用暖深灰（#2B2620 附近），'
      + '强调色用暖褐（#8A6A4B 附近）或暗红（#7A2E2E 附近），饱和度低。'
      + '底色可保持纯白或极淡米色（#FDFCF9）。'
      + '字体以衬线为主（Garamond / Georgia / SimSun），'
      + '标题字号不必大，靠字重与留白建立层级。'
      + '密度取 airy，行高取 1.7–2.0，段落间距充裕。'
      + '规则线用 thin 或 none；cornerRadius 为 0；'
      + '避免色块与边框，让纯粹的排布承担全部视觉秩序。',
    appliesTo: ['resume', 'cover-letter'],
  },
  {
    id: 'classic',
    name: '传统标准',
    tagline: '最保守也最安全的写法 —— 任何 ATS 都能读，任何 HR 都不会皱眉。',
    hints: [
      '纯黑白，最多加一个极克制的深灰强调',
      '通用字体（Arial / Calibri / 宋体），单栏到底',
      '板块标题全大写 + 下划线，小节内项目符号统一',
      '中等密度，标准 1.15–1.3 行高',
    ],
    brief:
      '风格取向：需要投递给大型企业、国企、体制内或经过 ATS 解析的场景。'
      + '唯一目标是"没有任何可能引起误读的地方"。'
      + '配色严格限制为黑／近黑（#111827）文本 + 纯白底，'
      + '若需强调，只用中灰（#4B5563）。不得使用彩色强调。'
      + '字体只用最通用的那几个（Arial / Calibri / Microsoft YaHei / SimSun），'
      + '确保任何环境都能正确回退。'
      + '布局必须单栏（single-column），不做侧栏。'
      + '板块标题用 banded 或带下划线的方式，与正文区分清楚。'
      + '密度取 balanced，行高 1.15–1.3。规则线用 thin。'
      + 'cornerRadius 为 0，不使用任何色块、图标与图形。',
    appliesTo: ['resume', 'cover-letter'],
  },
  {
    id: 'warm-letter',
    name: '诚恳得体',
    tagline: '求职信的默认取向：像是认真写给某个人，而不是群发。',
    hints: [
      '单栏、宽松行距，读起来像一封信而不是一份表',
      '暖中性色，强调色仅用于署名与日期',
      '标题极小或干脆不要标题，让正文自己开场',
      '留白多于简历 —— 这封信应该看起来"值得读"',
    ],
    brief:
      '风格取向：正式求职信。目标是让人愿意从头读到尾。'
      + '整体应当像一封写得认真的信，而不是一份被压缩成页面的表格。'
      + '必须单栏（single-column），不使用侧栏与分栏。'
      + '配色取暖中性：正文深灰（#1F2937），署名与日期可用低调的暖褐或藏青强调。'
      + '字体用衬线或中性无衬线，避免花哨字体。'
      + '密度取 balanced 或 airy，行高不低于 1.5，段落间距明显。'
      + '标题层级尽量弱化（如果原文有标题，不要把它处理成很醒目的样式）。'
      + '规则线用 none 或 thin，cornerRadius 为 0。'
      + '不添加任何色块、边框与图形装饰。',
    appliesTo: ['cover-letter'],
  },
  {
    id: 'bold-letter',
    name: '有力直给',
    tagline: '给创业公司与快节奏团队的版本：短、亮、一眼看到重点。',
    hints: [
      '可以有明确的主色，标题带色彩',
      '行距适中，段落短促，重点句允许加粗',
      '允许一条强调色横线或小色块作为视觉锚点',
      '仍保持单栏 —— 求职信的阅读路径必须是直线',
    ],
    brief:
      '风格取向：投递给创业公司、互联网团队、创意行业的求职信。'
      + '传达"有条理、有行动力、不啰嗦"。'
      + '可以使用明确的主色（如靛蓝 #4338CA 或深青 #0F766E）用于标题与一条强调横线。'
      + '布局保持单栏（single-column）—— 求职信的阅读路径必须是直线。'
      + '字体用现代无衬线。行距 1.4–1.6，段落之间间距明显。'
      + '密度取 balanced，不要为了塞内容而压缩留白。'
      + '允许少量圆角（4–8）与一条 accent-bar 规则线作为视觉锚点，'
      + '但不得使用阴影、渐变或背景图。',
    appliesTo: ['cover-letter'],
  },
];

/** 某一板块可用的预设。 */
export function presetsFor(type: DocType): readonly DesignPreset[] {
  return PRESETS.filter((p) => p.appliesTo.includes(type));
}

/** 按 id 查预设。 */
export function findPreset(id: string | null): DesignPreset | undefined {
  if (!id) return undefined;
  return PRESETS.find((p) => p.id === id);
}

/** 选中预设时要预填的自定义风格文本；无预设或预设无 seed 时返回 null。 */
export function profileFor(type: DocType, presetId: string | null): string | undefined {
  const preset = findPreset(presetId);
  if (!preset) return undefined;
  if (!preset.appliesTo.includes(type)) return undefined;
  return preset.customSeed;
}

/**
 * 组装成 prompt 用的风格段落。
 *
 * 预设 brief 与用户自定义要求是**叠加**关系而非替换：
 * 用户选"金融"又补充"希望标题大一些"，两者都应当生效。
 * 因此这里如实拼接，把取舍交给模型 —— 并在文字上明确优先级。
 */
export function buildStyleBrief(
  presetId: string | null,
  customStyle: string,
): string {
  const preset = findPreset(presetId);
  const parts: string[] = [];

  if (preset) {
    parts.push(`【预设风格：${preset.name}】\n${preset.brief}`);
  }
  if (customStyle.trim().length > 0) {
    const label = preset ? '【用户的补充要求（优先于预设）】' : '【用户的风格要求】';
    parts.push(`${label}\n${customStyle.trim()}`);
  }

  if (parts.length === 0) {
    parts.push(
      '【未指定风格】请自行选择一种适合该文档类型的专业排版方案，'
      + '保持克制、清晰、易读。',
    );
  }

  return parts.join('\n\n');
}
