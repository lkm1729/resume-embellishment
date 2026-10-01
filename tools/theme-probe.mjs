#!/usr/bin/env node
/**
 * theme-probe.mjs —— 在**真实应用窗口**里量主题 token、字体与版本号。
 *
 * 为什么不用浏览器直接开 `dist/`：Tauri 的 CSP、`asset:` 协议、`__APP_VERSION__`
 * 注入都只在真的宿主里才有，浏览器里量出来的东西不能代表交付物。
 *
 * 做法：用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 给 WebView2 开一个 CDP 端口，
 * 然后用 Node 自带的全局 `WebSocket`（Node 22+，本机 24.19.0）直连 DevTools 协议，
 * 在页面里 `Runtime.evaluate` 一段脚本。全程零依赖。
 *
 * 量的东西：
 *   1. `data-theme` 存在，且浅/深两套 token 都能解析出预期颜色
 *      （浅色 `--color-canvas` = #e5e7eb，深色 = #12161d；浅色下
 *      `[data-theme='light']` 必须能压过 `@theme` 里的深色默认值）；
 *   2. `--color-paper-edge` 在两套主题下都非空 —— 浅色画布与白纸对比度只有 1.24:1，
 *      这一圈描边就是纸张边界的全部依据；
 *   3. 侧边栏版本号形如 `V1.0.0 (20261001)`；
 *   4. 界面字体栈里 Google Sans Flex 与 Noto Sans SC 都在，且两个 webfont 真的加载成功；
 *   5. 点击外观按钮能循环主题（浅 → 深 → 跟随系统），标签与 `data-theme` 同步变化。
 *
 * 用法：node tools/theme-probe.mjs [--keep]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  connectCdp,
  countLiveAppInstances,
  fail,
  firstPanic,
  killLiveAppInstances,
  log,
  ok,
  pickLaunchableExe,
  preflight,
  resolveOutDir,
  spawnApp,
  stopApp,
  waitForReady,
  warn,
} from './desktop-paths.mjs';

const KEEP = process.argv.includes('--keep');

/** 预期颜色（都是「在真实元素上取 computed color」之后的形式）。 */
const EXPECT = {
  light: {
    canvas: 'rgb(229, 231, 235)', // #e5e7eb
    ink900: 'rgb(248, 250, 252)', // #f8fafc
    paperEdgeAlpha: '0.12', // rgb(15 23 42 / 0.12)
  },
  dark: {
    canvas: 'rgb(18, 22, 29)', // #12161d
    ink900: 'rgb(24, 29, 38)', // #181d26
    paperEdgeAlpha: '0.45', // rgb(0 0 0 / 0.45)
  },
};

/**
 * 在页面里跑的那段脚本。
 *
 * 注意：这段字符串本身是外层模板字面量的一部分，所以内部**不能再用反引号**。
 */
const PROBE = `(async () => {
  await document.fonts.ready;
  const root = document.documentElement;

  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;';
  document.body.appendChild(probe);

  const color = (token) => {
    probe.style.color = 'var(' + token + ')';
    const v = getComputedStyle(probe).color;
    probe.style.color = '';
    return v;
  };
  const edge = (token) => {
    probe.style.boxShadow = '0 0 0 1px var(' + token + ')';
    const v = getComputedStyle(probe).boxShadow;
    probe.style.boxShadow = '';
    const m = v.match(/rgba?\\([^)]*\\)/);
    return m ? m[0] : v;
  };

  const measure = () => ({
    canvas: color('--color-canvas'),
    ink900: color('--color-ink-900'),
    ink950: color('--color-ink-950'),
    guide: color('--color-guide'),
    paperEdge: edge('--color-paper-edge'),
  });

  const original = root.dataset.theme;
  root.dataset.theme = 'light';
  const light = measure();
  root.dataset.theme = 'dark';
  const dark = measure();
  root.dataset.theme = original;

  const buttons = Array.from(document.querySelectorAll('button'));
  const versionBtn = buttons.find((b) => /^V[0-9]+\\.[0-9]+\\.[0-9]+\\s*\\([0-9]{8}\\)$/.test((b.textContent || '').trim()));
  const themeQuery = () => document.querySelector('button[aria-label^="外观："]');

  const cycle = [];
  for (let i = 0; i < 3; i++) {
    const btn = themeQuery();
    if (!btn) break;
    btn.click();
    await new Promise((r) => setTimeout(r, 350));
    const now = themeQuery();
    cycle.push({
      label: (now && now.getAttribute('aria-label')) || null,
      theme: root.dataset.theme || null,
    });
  }

  const families = getComputedStyle(document.body).fontFamily;
  const fonts = {
    bodyFamily: families,
    loaded: Array.from(document.fonts)
      .filter((f) => f.status === 'loaded')
      .map((f) => f.family),
    notoUsable: document.fonts.check('16px "Noto Sans SC"'),
    googleUsable: document.fonts.check('16px "Google Sans Flex"'),
    latinMeasured: null,
  };

  // 逐个字形回退的实际证据：同样的字号下，「Latin」与「中文」的宽度比若接近 1:1，
  // 说明两者用了同一套字体（回退没生效）。这里只记录，不做断言。
  probe.style.fontFamily = families;
  probe.style.fontSize = '64px';
  probe.textContent = 'Hamburgefonstiv';
  const latin = probe.getBoundingClientRect().width;
  probe.textContent = '中文测试字形';
  const cjk = probe.getBoundingClientRect().width;
  fonts.latinMeasured = { latin, cjk };

  probe.remove();

  return {
    theme: root.dataset.theme || null,
    version: versionBtn ? versionBtn.textContent.trim() : null,
    themeLabel: (themeQuery() && themeQuery().getAttribute('aria-label')) || null,
    views: { light, dark },
    fonts,
    cycle,
    title: document.title,
    url: location.href,
  };
})()`;

/** 通过返回 0、失败返回 1，方便直接 `failures += check(...)`。 */
function check(cond, label, detail) {
  if (cond) ok(label);
  else fail(`${label}${detail ? ` —— ${detail}` : ''}`);
  return cond ? 0 : 1;
}

async function main() {
  log('主题与字体探针');
  const exePath = pickLaunchableExe();
  const pre = preflight(exePath);
  if (pre.live > 0) {
    warn(`有 ${pre.live} 个实例还在跑，先清掉`);
    killLiveAppInstances();
  }
  if (!pre.safe) for (const p of pre.problems) warn(p);

  log(`启动 ${exePath}（带 CDP 端口）`);
  const child = spawnApp(exePath, { debug: true });
  let failures = 0;
  let cdp = null;
  try {
    const ready = await waitForReady(exePath, 30_000);
    if (!ready.ready) {
      fail(ready.panicked ? '启动即崩溃' : '30 s 内没等到「启动完成」');
      const panic = firstPanic(ready.tail || '');
      if (panic) console.log(`     ${panic}`);
      throw new Error('应用没起来，探针无法继续');
    }
    ok('应用已启动');

    cdp = await connectCdp();
    ok(`CDP 已连上（${cdp.target.title || cdp.target.url}）`);

    const report = await cdp.evaluate(PROBE);
    const outDir = resolveOutDir('theme-probe');
    const reportPath = join(outDir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    ok(`报告写到 ${reportPath}`);

    log('断言');
    failures += check(
      /^V\d+\.\d+\.\d+ \(\d{8}\)$/.test(report.version || ''),
      `版本号形如 V1.0.0 (20261001)：${report.version}`,
      report.version ? '' : '侧边栏里没找到版本按钮',
    );
    failures += check(!!report.theme, `data-theme 存在：${report.theme}`);

    for (const mode of ['light', 'dark']) {
      const v = report.views[mode];
      failures += check(
        v.canvas === EXPECT[mode].canvas,
        `${mode} --color-canvas = ${EXPECT[mode].canvas}`,
        `实际 ${v.canvas}`,
      );
      failures += check(
        v.ink900 === EXPECT[mode].ink900,
        `${mode} --color-ink-900 = ${EXPECT[mode].ink900}`,
        `实际 ${v.ink900}`,
      );
      failures += check(
        (v.paperEdge || '').includes(EXPECT[mode].paperEdgeAlpha),
        `${mode} --color-paper-edge 含 ${EXPECT[mode].paperEdgeAlpha}`,
        `实际 ${v.paperEdge}`,
      );
    }

    failures += check(
      /Google Sans Flex/i.test(report.fonts.bodyFamily || ''),
      '字体栈里有 Google Sans Flex',
      report.fonts.bodyFamily,
    );
    failures += check(
      /Noto Sans SC/i.test(report.fonts.bodyFamily || ''),
      '字体栈里有 Noto Sans SC',
      report.fonts.bodyFamily,
    );
    failures += check(
      report.fonts.googleUsable === true,
      'Google Sans Flex webfont 可用',
      `loaded=[${report.fonts.loaded.join(', ')}]`,
    );
    failures += check(
      report.fonts.notoUsable === true,
      'Noto Sans SC webfont 可用',
      `loaded=[${report.fonts.loaded.join(', ')}]`,
    );

    const labels = report.cycle.map((c) => c.label);
    failures += check(
      new Set(labels).size === 3,
      `点击能循环三种外观：${labels.map((l) => (l || '').replace('外观：', '')).join(' → ')}`,
    );
    failures += check(
      report.cycle.every((c) => c.theme === 'light' || c.theme === 'dark'),
      '每次点击后 data-theme 都是 light/dark',
      JSON.stringify(report.cycle),
    );

    console.log('\n---- 探针报告 ----');
    console.log(`  标题        ${report.title}`);
    console.log(`  版本        ${report.version}`);
    console.log(`  浅色 canvas ${report.views.light.canvas}   纸张描边 ${report.views.light.paperEdge}`);
    console.log(`  深色 canvas ${report.views.dark.canvas}   纸张描边 ${report.views.dark.paperEdge}`);
    console.log(`  字体        ${report.fonts.bodyFamily}`);
    console.log(`  已加载      ${report.fonts.loaded.join(', ')}`);
    console.log(`  字宽实测    latin=${report.fonts.latinMeasured.latin.toFixed(1)} cjk=${report.fonts.latinMeasured.cjk.toFixed(1)}`);
  } finally {
    if (cdp) cdp.close();
    if (KEEP) ok('--keep：进程留着不杀');
    else await stopApp(child);
  }

  if (failures) {
    fail(`${failures} 项断言未通过`);
    process.exit(1);
  }
  const leftovers = countLiveAppInstances();
  if (leftovers > 0) warn(`还有 ${leftovers} 个实例没退干净`);
  log('探针全部通过');
}

main().catch((e) => {
  fail(String(e?.stack || e));
  process.exit(1);
});
