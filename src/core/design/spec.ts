import { z } from 'zod';

/**
 * DesignSpec —— LLM 的**唯一**输出。
 *
 * ═══════════════════════════════════════════════════════════════
 *  核心约束（本项目的立身之本）：
 *  本 schema 中**不存在任何可以承载用户正文的字段**。
 *
 *  模型能做的一切，就是引用内容单元的 ID（contentId）并指定样式。
 *  它在物理上无法输出、改写、增删用户写的任何一个字。
 *  「美化而非改写」由此成为**类型系统保证**，而非事后校验。
 * ═══════════════════════════════════════════════════════════════
 *
 * 若将来要新增字段，请先自问：这个字段能不能装下一段用户文字？
 * 能，就不要加。
 */

/**
 * 字体白名单 —— 防止模型编造系统中不存在的字体导致静默回退。
 *
 * ═══════════════════════════════════════════════════════════════
 *  收录标准：**Windows 自带**（HKLM 注册的系统级字体）。
 *
 *  为什么标准定得这么紧：白名单的唯一作用是「保证选到的字体
 *  真的能渲染出来」。此前的清单里有 11 个字体在本机并未安装 ——
 *  Inter / Open Sans / Lato / Merriweather / Playfair Display /
 *  EB Garamond / Source Sans 3 / JetBrains Mono / Helvetica /
 *  Source Han Sans SC / Source Han Serif SC。
 *
 *  而渲染栈是 `"${fontPair.heading}", "Microsoft YaHei", ...`
 *  （见 render.ts），缺失时**静默回退到雅黑**。也就是说白名单
 *  本想防的事，恰恰被它自己引入了：模型选 Inter，用户看到雅黑，
 *  且没有任何提示。
 *
 *  改成只收 Windows 自带字体后，这个保证是**跨机器成立**的 ——
 *  应用会被复制到别的 Windows 机器上运行，而自带字体必然存在。
 *  代价是失去了一些更考究的字体（如 Source Serif、EB Garamond），
 *  换来的是一致性与可预期。若将来要找回它们，正确做法是像界面
 *  字体那样**内嵌子集**，而不是把它们放回白名单里碰运气。
 *
 *  改动本清单后无需手工同步 JSON Schema ——
 *  `DESIGN_SPEC_JSON_SCHEMA` 里的 enum 直接由本数组展开。
 * ═══════════════════════════════════════════════════════════════
 */
export const FONT_WHITELIST = [
  // ── 中文：无衬线 ──
  'Microsoft YaHei', // 微软雅黑，Windows 中文默认
  'DengXian', // 等线，Win10 起自带，比雅黑清瘦
  'SimHei', // 黑体
  // ── 中文：衬线／书写 ──
  'SimSun', // 宋体，最保守的选择
  'FangSong', // 仿宋，公文感
  'KaiTi', // 楷体，书法感
  // ── 拉丁：无衬线 ──
  'Arial',
  'Calibri', // Word 默认，简历里最不冒险
  'Segoe UI', // 系统中性体
  'Verdana', // 高可读性
  'Trebuchet MS',
  'Candara',
  // ── 拉丁：衬线 ──
  'Georgia',
  'Times New Roman',
  'Cambria',
  'Garamond',
  'Palatino Linotype',
  // ── 等宽 ──
  'Consolas',
  'Courier New',
] as const;

export const FontName = z.enum(FONT_WHITELIST);

/**
 * 手工维护的 JSON Schema（供 LLM 的结构化输出使用）。
 *
 * 为什么不从 zod 自动生成：
 * 生成器会在产物里夹带 `$schema`、`additionalProperties` 等大量样板，
 * 而不同兼容端点对 JSON Schema 的接受度差异极大 —— 越简单越容易通过。
 * 这份手写版本只保留端点普遍支持的关键字（type / properties / required / enum）。
 *
 * ⚠⚠ 整数不要用 `enum` 表达范围 —— 用 `minimum` / `maximum`。
 * Gemini 的 `Schema.enum` 是 `repeated string`，任何非字符串成员都会被拒：
 *
 *     HTTP 400 Invalid value at '…response_schema.properties[2]…enum[0]' (TYPE_STRING)
 *
 * 中转端点把 OpenAI 的 `response_format.json_schema.schema` 原样映射成
 * `generation_config.response_schema`，于是「合法的 JSON Schema」变成了 400。
 * 这里给出的约束只是**给模型的提示**，真正的把关在下面的 zod（如 `z.literal(1)`），
 * 所以换成数值区间不会削弱任何校验强度。
 *
 * ⚠ 新增 DesignSpecSchema 字段时必须同步更新这里，
 * `spec.schema-sync.test.ts` 有一条测试守着两者一致。
 */
export const DESIGN_SPEC_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'layout', 'theme', 'sections'],
  properties: {
    // 恒为 1；区间写法取代 `enum: [1]`，见上文。
    version: { type: 'integer', minimum: 1, maximum: 1 },
    rationale: { type: 'string' },
    layout: {
      type: 'object',
      additionalProperties: false,
      required: ['template', 'sectionOrder', 'density'],
      properties: {
        template: {
          type: 'string',
          enum: ['single-column', 'two-column-left', 'two-column-right', 'sidebar-hybrid'],
        },
        sectionOrder: {
          type: 'array',
          items: { type: 'string', maxLength: 60 },
        },
        density: { type: 'string', enum: ['compact', 'balanced', 'airy'] },
      },
    },
    theme: {
      type: 'object',
      additionalProperties: false,
      required: ['palette', 'fontPair', 'scale', 'ruleStyle', 'cornerRadius'],
      properties: {
        palette: {
          type: 'object',
          additionalProperties: false,
          required: ['primary', 'accent', 'text', 'muted', 'bg'],
          properties: {
            primary: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
            accent: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
            text: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
            muted: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
            bg: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
          },
        },
        fontPair: {
          type: 'object',
          additionalProperties: false,
          required: ['heading', 'body'],
          properties: {
            heading: { type: 'string', enum: [...FONT_WHITELIST] },
            body: { type: 'string', enum: [...FONT_WHITELIST] },
          },
        },
        scale: {
          type: 'object',
          additionalProperties: false,
          required: ['h1', 'h2', 'body', 'lineHeight'],
          properties: {
            h1: { type: 'number' },
            h2: { type: 'number' },
            body: { type: 'number' },
            lineHeight: { type: 'number' },
          },
        },
        ruleStyle: {
          type: 'string',
          enum: ['none', 'thin', 'thick', 'accent-bar', 'double'],
        },
        cornerRadius: { type: 'number' },
      },
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'style', 'units'],
        properties: {
          section: { type: 'string', maxLength: 60 },
          style: {
            type: 'object',
            additionalProperties: false,
            required: ['emphasis'],
            properties: {
              emphasis: { type: 'string', enum: ['normal', 'boxed', 'banded'] },
              // 同上：整数用区间，不用 `enum: [1, 2]`。
              columns: { type: 'integer', minimum: 1, maximum: 2 },
            },
          },
          units: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['contentId'],
              properties: {
                contentId: { type: 'string', pattern: '^u[0-9]{4}$' },
                style: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    weight: { type: 'string', enum: ['normal', 'medium', 'bold'] },
                    as: { type: 'string', enum: ['h3', 'h4', 'p', 'li'] },
                    muted: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

/** 颜色仅接受 hex，避免注入任意 CSS。 */
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, '必须是 6 位十六进制颜色，如 #1F2937');

export const LayoutSchema = z.object({
  template: z.enum(['single-column', 'two-column-left', 'two-column-right', 'sidebar-hybrid']),
  /** 板块顺序。只能引用已存在的板块名；校验在 spec 之外用 verifyCoverage 兜底。 */
  sectionOrder: z.array(z.string().max(60)),
  /**
   * 版式密度 —— **只管块间距**（板块之间、条目之间的距离）。
   * 行高是另一件事，由 `theme.scale.lineHeight` 控制。
   * 两个旋钮分开是为了让"想更紧凑"这个意图有明确的落点。
   */
  density: z.enum(['compact', 'balanced', 'airy']),
});

export const ThemeSchema = z.object({
  palette: z.object({
    primary: HexColor,
    accent: HexColor,
    text: HexColor,
    muted: HexColor,
    bg: HexColor,
  }),
  fontPair: z.object({
    heading: FontName,
    body: FontName,
  }),
  /** 相对倍数，渲染层乘以基准字号。范围受限以防"放大到撑爆页面"。 */
  scale: z.object({
    h1: z.number().min(0.8).max(3.0),
    h2: z.number().min(0.8).max(2.4),
    body: z.number().min(0.8).max(1.6),
    lineHeight: z.number().min(1.0).max(2.4),
  }),
  ruleStyle: z.enum(['none', 'thin', 'thick', 'accent-bar', 'double']),
  cornerRadius: z.number().min(0).max(24),
});

export const UnitStyleSchema = z.object({
  /** ← 只能是引用。这是模型唯一能"提及"用户内容的方式。 */
  contentId: z.string().regex(/^u\d{4}$/, '内容单元 ID 形如 u0001'),
  style: z
    .object({
      weight: z.enum(['normal', 'medium', 'bold']).optional(),
      as: z.enum(['h3', 'h4', 'p', 'li']).optional(),
      muted: z.boolean().optional(),
    })
    .optional(),
});

export const SectionSpecSchema = z.object({
  section: z.string().max(60),
  style: z.object({
    emphasis: z.enum(['normal', 'boxed', 'banded']),
    columns: z.union([z.literal(1), z.literal(2)]).optional(),
  }),
  units: z.array(UnitStyleSchema),
});

export const DesignSpecSchema = z.object({
  version: z.literal(1),
  layout: LayoutSchema,
  theme: ThemeSchema,
  sections: z.array(SectionSpecSchema),
  /**
   * 设计说明，展示给用户看「为什么这么设计」。
   * 注意：此字段**绝不进入渲染 DOM**，仅作 UI 文案，因此自由文本是安全的。
   * 渲染层不得读取本字段。
   */
  rationale: z.string().max(2000).optional(),
});

export type DesignSpec = z.infer<typeof DesignSpecSchema>;
export type Layout = z.infer<typeof LayoutSchema>;
export type Theme = z.infer<typeof ThemeSchema>;
export type SectionSpec = z.infer<typeof SectionSpecSchema>;
export type UnitStyle = z.infer<typeof UnitStyleSchema>;

/** 从 spec 中提取全部被引用的内容单元 ID（用于 verifyCoverage）。 */
export function collectReferencedIds(spec: DesignSpec): string[] {
  const ids: string[] = [];
  for (const section of spec.sections) {
    for (const unit of section.units) {
      ids.push(unit.contentId);
    }
  }
  return ids;
}

/** 提取 sectionOrder 中出现的板块名（用于与原文板块比对）。 */
export function collectOrderedSections(spec: DesignSpec): string[] {
  return [...spec.layout.sectionOrder];
}

// ─────────────────────── 用户自定义字体的覆盖层 ───────────────────────

/**
 * 用户手工指定的字体。`null` 表示这一项**交给模型决定**。
 *
 * 「交给模型决定」和「明确选了某个字体」必须是两种不同的状态，
 * 所以这里用 `null` 而不是拿空字符串兼表两者 ——
 * 空串在字体栈里会拼出一个空的名字，整条 `font-family` 声明会被浏览器丢掉。
 */
export interface FontOverride {
  readonly heading: string | null;
  readonly body: string | null;
}

/** 两项都没指定。 */
export const NO_FONT_OVERRIDE: FontOverride = { heading: null, body: null };

/**
 * 把一个字段读成「指定了」还是「没指定」。
 *
 * 空白字符串一律当没指定。上面的注释说了空串会让整条 `font-family`
 * 声明被丢掉，那就得在**读**的地方也把它挡掉，光写注释不算数 ——
 * `string | null` 这个类型允许传 `''` 进来，防御不能只靠调用方守规矩。
 */
function filled(name: string | null): string | null {
  const trimmed = name?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/** 用户是否至少指定了一项字体。 */
export function hasFontOverride(override: FontOverride): boolean {
  return filled(override.heading) !== null || filled(override.body) !== null;
}

/**
 * 把用户选的字体盖到 spec 上，供**渲染与导出**使用。
 *
 * # 为什么做成覆盖层，而不是写回 store 里那份 spec
 *
 * `theme.fontPair` 受 `FontName = z.enum(FONT_WHITELIST)` 约束，
 * 那是一道给**模型输出**把关的闸门：挡住本机根本没装的字体，
 * 免得渲染栈把 `"Inter", "Microsoft YaHei", …` 静默回退成雅黑，
 * 用户以为自己选了个考究的字体，其实看到的一直是默认的。
 *
 * 但用户的手工选择必须能越过这道闸门 —— 他本机装了华文行楷，
 * 就应该能选它，这正是「根据用户电脑内拥有的字体决定」的意思。
 * 可要是把用户字体写进 store 里那份 spec，下一次「继续调整」会把它
 * 原样发给模型，回来还要再走一遍 zod 校验，那时 `华文行楷` 不在白名单里，
 * **整轮调整会直接失败**，而报错完全看不出跟字体有关。
 *
 * 所以覆盖只发生在渲染/导出之前这一层：
 * store 里那份永远还是合法的模型输出，校验、修复轮、调整一律照旧。
 *
 * 没有覆盖、或者用户选的正好就是模型选的那个时，**原样返回同一个对象**
 * （不拷贝）。这个函数在渲染路径上，每次预览都会跑一遍，
 * 返回新对象会让下游所有 memo 失效、整篇文档重排一次。
 */
export function withFontOverride(spec: DesignSpec, override: FontOverride): DesignSpec {
  if (!hasFontOverride(override)) return spec;

  const heading = filled(override.heading) ?? spec.theme.fontPair.heading;
  const body = filled(override.body) ?? spec.theme.fontPair.body;

  if (heading === spec.theme.fontPair.heading && body === spec.theme.fontPair.body) {
    return spec;
  }

  return {
    ...spec,
    theme: {
      ...spec.theme,
      fontPair: { heading: asFontName(heading), body: asFontName(body) },
    },
  };
}

/**
 * 把外部字体名标成白名单里的字体名。
 *
 * 这是全项目**唯一**一处允许让 `fontPair` 脱离白名单的地方，
 * 所以刻意收成一个函数而不是散落两处 `as`。
 * 断言在这里成立的理由：产出的这份 spec 只流向渲染与导出，
 * 不会再经过 zod 校验，也不会被存回 store 或发给模型 ——
 * 白名单要保护的两件事（渲染不出、模型往返失败）都不经过它。
 */
function asFontName(name: string): z.infer<typeof FontName> {
  return name as z.infer<typeof FontName>;
}
