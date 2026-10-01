/**
 * 主题：深浅色的唯一真相来源。
 *
 * ═══════════════════════════════════════════════════════════════
 *  为什么是「改 CSS 变量」而不是「改组件 class」
 *
 *  Tailwind 4 把 --color-ink-900 编译成 var()：
 *      .bg-ink-900 { background-color: var(--color-ink-900) }
 *  （在 dist 产物里核对过。）
 *
 *  因此换肤只需重定义变量，全项目 195 处 ink-* 与 48 处强调色
 *  调用点一行都不用改。若改成给每个元素挂 dark:/light: 前缀，
 *  要动 243 处，且以后每加一个组件都要记得双写 —— 那是必然会漏的。
 * ═══════════════════════════════════════════════════════════════
 *
 * 三态：light / dark / system。
 * system 的意义是「跟随操作系统」，因此它必须**监听**系统变化，
 * 而不是在启动时读一次。用户在系统设置里切了主题，应用要跟着变。
 */

import { create } from 'zustand';
import { load } from '@tauri-apps/plugin-store';

/** 用户的偏好。`system` 表示跟随操作系统。 */
export type ThemePref = 'light' | 'dark' | 'system';

/** 实际生效的主题（system 已被解析掉）。 */
export type ResolvedTheme = 'light' | 'dark';

/** plugin-store 里的键名。 */
const STORE_FILE = 'settings.json';
const KEY_THEME = 'theme';

/**
 * localStorage 作为 plugin-store 的缓存。
 *
 * 为什么要两层：`plugin-store` 是异步 IPC，而首屏必须在**第一帧**
 * 就知道该用哪套主题，否则会先画深色再跳浅色（FOUC）。
 * 主进程侧读得太慢，所以用同步的 localStorage 做首帧真相，
 * 再用 plugin-store 做持久化 —— 两者都是同一个值。
 */
const LS_KEY = 're.theme';

/** 读取缓存的偏好；拿不到就当 system。 */
function cachedPref(): ThemePref {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* 隐私模式等场景下 localStorage 可能不可用，忽略 */
  }
  return 'system';
}

/** 把偏好写进缓存与持久化存储。 */
function persistPref(pref: ThemePref): void {
  try {
    localStorage.setItem(LS_KEY, pref);
  } catch {
    /* 忽略：缓存失败不影响本次会话 */
  }
  // 持久化是尽力而为：失败时下次启动回到 system，
  // 比因为一个偏好写不进就让整个动作报错要好。
  void (async () => {
    try {
      const store = await load(STORE_FILE, { autoSave: true });
      await store.set(KEY_THEME, pref);
    } catch {
      /* 忽略 */
    }
  })();
}

/** 系统当前偏好。 */
function systemTheme(): ResolvedTheme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 把解析后的主题写到 DOM。 */
function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
  // color-scheme 让原生控件（滚动条、下拉框、日期选择器）跟着变。
  // 不设它的话，浅色模式下滚动条仍是深色的，看起来像渲染故障。
  document.documentElement.style.colorScheme = resolved;
}

interface ThemeState {
  pref: ThemePref;
  /** 解析后的主题，渲染用。 */
  resolved: ResolvedTheme;

  /** 设置偏好（会持久化）。 */
  setPref: (pref: ThemePref) => void;
  /** 在 light → dark → system 之间循环，供单键切换。 */
  cycle: () => void;
  /** 启动时调用：读缓存、解析、订阅系统变化。返回取消订阅函数。 */
  init: () => () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  pref: cachedPref(),
  resolved: 'dark',

  setPref(pref) {
    const resolved: ResolvedTheme = pref === 'system' ? systemTheme() : pref;
    persistPref(pref);
    applyTheme(resolved);
    set({ pref, resolved });
  },

  cycle() {
    const order = ['light', 'dark', 'system'] as const;
    const idx = order.indexOf(get().pref as (typeof order)[number]);
    // 取模保证越界也能回到有效值（`noUncheckedIndexedAccess` 下
    // 下标访问的类型是 ThemePref | undefined）
    const next = order[(idx + 1) % order.length] ?? 'system';
    get().setPref(next);
  },

  init() {
    // 1. 先按缓存同步落地，避免首帧闪烁
    const pref = get().pref;
    const resolved: ResolvedTheme = pref === 'system' ? systemTheme() : pref;
    applyTheme(resolved);
    set({ resolved });

    // 2. 再从持久化存储读一次 —— 缓存可能过期
    //    （比如用户在别处清了 localStorage，或换了版本）
    void (async () => {
      try {
        const store = await load(STORE_FILE, { autoSave: true });
        const saved = await store.get<ThemePref>(KEY_THEME);
        if (saved === 'light' || saved === 'dark' || saved === 'system') {
          if (saved !== get().pref) get().setPref(saved);
        }
      } catch {
        /* 读不到就用缓存值，不报错 */
      }
    })();

    // 3. 订阅系统变化。**只在 pref==='system' 时**跟随即时生效，
    //    否则用户显式选了浅色却被系统切换覆盖，那是 bug 不是特性。
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return () => {};

    const onChange = () => {
      if (get().pref !== 'system') return;
      const next = systemTheme();
      applyTheme(next);
      set({ resolved: next });
    };

    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  },
}));

/**
 * 带过渡地切换主题。
 *
 * 过渡只在这 220ms 内挂上 `.theme-switching`，然后立刻摘掉 ——
 * 常驻过渡会让首次绘制也走动画，且与交互动效互相干扰。
 */
export function switchTheme(pref: ThemePref): void {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  useThemeStore.getState().setPref(pref);
  window.setTimeout(() => root.classList.remove('theme-switching'), 220);
}

/** 三态的显示文案与图标名。 */
export const THEME_META: Record<ThemePref, { label: string; hint: string }> = {
  light: { label: '浅色', hint: '白底蓝调' },
  dark: { label: '深色', hint: '黑底金调' },
  system: { label: '跟随系统', hint: '随操作系统设置变化' },
};
