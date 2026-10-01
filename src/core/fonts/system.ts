/**
 * 本机字体目录：加载、缓存、分组、过滤。
 *
 * 后端 `list_system_fonts` 返回的是**字体族**而不是字体全名
 * （理由见 `src-tauri/src/fonts.rs`：注册表那份名字里混着一半样式变体，
 * 选中 `Arial Bold` 会静默回退，等于选了个寂寞）。
 * 这里只做四件事：取一次并缓存、分成「内置推荐 / 本机其他」、
 * 补上中文字体的本地化别名、给选择器做过滤。
 */

import { FONT_WHITELIST } from '@/core/design/spec';
import { listSystemFonts } from '@/core/llm/api';

/**
 * 内置白名单里几个中文字体的**本地化族名**。
 *
 * Windows 的字体枚举给的是本地化名字（`微软雅黑`），而白名单里写的是
 * 英文名（`Microsoft YaHei`）。两个名字在 Chromium 里都能用，
 * 但字符串不相等 —— 少了这层对照，`Microsoft YaHei` 会被判成
 * 「本机没装」而从推荐区消失，转而又以 `微软雅黑` 的身份混在下面
 * 两百多个名字里，用户会以为推荐列表坏了。
 *
 * 只列白名单里真实存在的那几个。注意不能写前缀匹配：
 * `微软雅黑 Light` 是**另一个字体族**，不该被当成同一个。
 */
const WHITELIST_ALIASES: Record<string, readonly string[]> = {
  'Microsoft YaHei': ['微软雅黑'],
  DengXian: ['等线'],
  SimHei: ['黑体'],
  SimSun: ['宋体'],
  FangSong: ['仿宋'],
  KaiTi: ['楷体'],
};

/** 一个可选项。`value` 写进 `font-family`，`label` 显示给人看。 */
export interface FontOption {
  /** 真正会写进 CSS / docx 的名字。 */
  readonly value: string;
  /** 界面上的显示名。中文字体这里会与 `value` 不同。 */
  readonly label: string;
  /** 过滤时一并匹配的名字（本地化名等）。 */
  readonly aliases: readonly string[];
}

export interface FontCatalog {
  /** 内置白名单里、且本机确实装了的字体。选择器置顶展示。 */
  readonly recommended: readonly FontOption[];
  /** 本机其余的字体族。 */
  readonly others: readonly FontOption[];
  /**
   * 是否真的读到了本机字体列表。
   *
   * `false` 表示只有内置兜底 —— 界面**必须**如实说明，
   * 否则用户会奇怪「我明明装了那个字体，为什么列表里没有」，
   * 而真相是这次没读到系统字体，不是那个字体不存在。
   */
  readonly fromSystem: boolean;
  /** 读系统字体失败的原因；成功时为 `null`。 */
  readonly error: string | null;
}

let cached: Promise<FontCatalog> | null = null;

/**
 * 取本机字体目录。整个会话只问后端一次 ——
 * 字体列表在一次运行期间不会变，每次开选择器都重取只是白等。
 */
export function loadFontCatalog(): Promise<FontCatalog> {
  cached ??= buildCatalog();
  return cached;
}

/** 丢掉缓存，下次重新去后端取。用户中途装了字体时用得上。 */
export function resetFontCatalog(): void {
  cached = null;
}

async function buildCatalog(): Promise<FontCatalog> {
  let system: string[] = [];
  let error: string | null = null;

  try {
    system = await listSystemFonts();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const fromSystem = system.length > 0;
  if (!fromSystem) {
    // 读不到就退回内置列表 —— 少而准，好过空着。
    // 这里**不**把 error 吞掉：界面要拿它说明为什么列表这么短。
    return {
      recommended: FONT_WHITELIST.map((f) => plainOption(f)),
      others: [],
      fromSystem: false,
      error,
    };
  }

  // 系统名 → 实际拼写。比较用不区分大小写，输出用系统那份拼写，
  // 免得 `segoe ui` 这种写法被原样写进 CSS 后匹配不到。
  const byLower = new Map<string, string>();
  for (const name of system) {
    byLower.set(name.toLowerCase(), name);
  }

  const recommended: FontOption[] = [];
  const claimed = new Set<string>();

  for (const white of FONT_WHITELIST) {
    // 先按原名找，再按本地化别名找。
    const candidates = [white, ...(WHITELIST_ALIASES[white] ?? [])];
    let hit: string | undefined;
    for (const candidate of candidates) {
      const actual = byLower.get(candidate.toLowerCase());
      if (actual) {
        hit = actual;
        break;
      }
    }
    if (!hit) continue;

    claimed.add(hit.toLowerCase());
    const localized = WHITELIST_ALIASES[white] ?? [];
    // label 用本地化名 —— 用户在自己的系统里看到的就是那个名字，
    // 拿 `Microsoft YaHei` 去找「微软雅黑」是找不到的。
    // value 仍然用白名单里的写法：模型产出的 spec 用的也是它，
    // 用户不覆盖时两边的行为完全一致，不会因为字体名写法不同而变样。
    //
    // ⚠ `localized` **不能**按 `hit` 过滤掉：命中往往正是那个本地化名
    // （系统枚举给的就是 `微软雅黑`），滤掉它就等于把要显示的名字扔了。
    recommended.push({
      value: white,
      label: localized[0] ?? white,
      aliases: [white, ...localized],
    });
  }

  const others: FontOption[] = system
    .filter((name) => !claimed.has(name.toLowerCase()))
    .map((name) => plainOption(name));

  return { recommended, others, fromSystem: true, error: null };
}

function plainOption(name: string): FontOption {
  return { value: name, label: name, aliases: [] };
}

/**
 * 按关键词过滤。
 *
 * 匹配名字本身，也匹配别名 —— 用户可能记得 `微软雅黑`，
 * 也可能记得 `Microsoft YaHei`，两个都该搜得到同一个字体。
 */
export function filterFonts(options: readonly FontOption[], keyword: string): FontOption[] {
  const q = keyword.trim().toLowerCase();
  if (q.length === 0) return [...options];

  return options.filter((option) => {
    if (option.label.toLowerCase().includes(q)) return true;
    if (option.value.toLowerCase().includes(q)) return true;
    return option.aliases.some((alias) => alias.toLowerCase().includes(q));
  });
}
