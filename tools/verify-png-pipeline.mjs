#!/usr/bin/env node
/**
 * verify-png-pipeline.mjs —— 验收「导出 PDF → pdfjs 栅格化 → PNG」这条链路。
 *
 * 为什么值得单独验：PNG 导出不靠任何浏览器截图，而是把 WebView2 打印出来的
 * 矢量 PDF 用 pdfjs-dist 重新画进 canvas。这条链路上有三个容易悄悄坏掉的点：
 *
 *   1. pdfjs 的分块（`dist/assets/pdf-*.js`）能不能被动态 import —— 有两种
 *      `pdf-*.js`，得在页面里挑出真正导出 `getDocument` 的那个；
 *   2. worker（`pdf.worker.min-*.mjs`）能不能起来 —— workerSrc 指错就静默失败；
 *   3. `cmaps/` 与 `standard_fonts/` 是否随 `public/pdfjs/` 一起进了 dist ——
 *      缺了它们，中日韩字形会渲染成空白（而且只在含中文的文档上暴露）。
 *
 * PDF 的字节是**从磁盘读出来再喂给页面**的，不依赖静态资源服务：release 构建
 * 会把 dist/ 在编译期烤进二进制（phf 常量表），构建之后往 dist/ 里丢文件是
 * 取不到的 —— 那样 `fetch` 只会拿到 `index.html`，报「Invalid PDF structure」。
 *
 * 另外它会把 canvas 的像素尺寸和 `src/core/export/export.ts` 里**实际写在源码
 * 中的**画布守卫常量（`CANVAS_MAX_SIDE` / `CANVAS_MAX_AREA` /
 * `PEAK_MEMORY_BUDGET_MB`）对一遍 —— 常量是从源码里读出来的，不是抄一遍，
 * 所以改了源码而忘了改守卫会在这里被抓住。
 *
 * 用法：node tools/verify-png-pipeline.mjs [--scale=2]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROJECT_ROOT,
  fail,
  log,
  ok,
  readText,
  resolveOutDir,
  warn,
  withApp,
} from './desktop-paths.mjs';

const SCALE = Number((process.argv.slice(2).find((a) => a.startsWith('--scale=')) || '').slice(8)) || 2;
const DIST = join(PROJECT_ROOT, 'dist');
const ASSETS = join(DIST, 'assets');
const OUT = resolveOutDir('png-check');
/** 导出的中间产物：放在 out/ 下，Node 读完就把字节喂进页面。 */
const PDF_PATH = join(OUT, 'check.pdf');

/** A4 在 96dpi 下的 CSS 像素（与 src/core/render/render.ts 的 A4_HEIGHT_PX 对齐）。 */
function readA4() {
  const src = readText(join(PROJECT_ROOT, 'src', 'core', 'render', 'render.ts'));
  const m = src.match(/A4_HEIGHT_PX\s*=\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * 从源码里读一个纯算术常量。只允许数字、`*`、`_`、空格，避免把任意表达式当代码跑。
 */
function readConst(name) {
  const src = readText(join(PROJECT_ROOT, 'src', 'core', 'export', 'export.ts'));
  const m = src.match(new RegExp(`${name}\\s*=\\s*([0-9_*\\s]+)`));
  if (!m) return null;
  const expr = m[1].replace(/_/g, '').trim();
  if (!/^[0-9* ]+$/.test(expr)) return null;
  try {
    return Function(`"use strict";return (${expr});`)();
  } catch {
    return null;
  }
}

let failures = 0;
function check(cond, label, detail) {
  if (cond) ok(label);
  else fail(`${label}${detail ? ` —— ${detail}` : ''}`);
  return cond ? 0 : 1;
}

/** 找 pdfjs 的候选分块。`pdf-*.js` 有两个，得在页面里试。 */
function candidates() {
  if (!existsSync(ASSETS)) return { modules: [], worker: null };
  const files = readdirSync(ASSETS);
  return {
    modules: files.filter((f) => /^pdf-[\w-]+\.js$/.test(f)),
    worker: files.find((f) => /^pdf\.worker\.min-[\w-]+\.mjs$/.test(f)) || null,
  };
}

/** 页面内的栅格化脚本。PDF 字节以 base64 直接内联进来。 */
function rasterExpr(b64, modules, worker) {
  return `(async () => {
    const B64 = ${JSON.stringify(b64)};
    const bin = atob(B64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);

    let lib = null, picked = null;
    const tried = [];
    for (const name of ${JSON.stringify(modules)}) {
      try {
        const m = await import('/assets/' + name);
        tried.push(name + ':' + (m && typeof m.getDocument === 'function' ? 'ok' : 'no-getDocument'));
        if (m && typeof m.getDocument === 'function') { lib = m; picked = name; break; }
      } catch (e) {
        tried.push(name + ':throw ' + ((e && e.message) || e));
      }
    }
    if (!lib) return { stage: 'import', error: '没有分块导出 getDocument', tried };

    // ⚠ pdfjs 会把 data 的底层 ArrayBuffer transfer 给 worker，之后 buf.length 变成 0，
    //    所以字节数必须在 getDocument 之前量。
    const pdfBytes = buf.length;
    let doc, page, canvas, ctx, dataUrl, baseW, baseH;
    try {
      lib.GlobalWorkerOptions.workerSrc = ${JSON.stringify('/assets/' + worker)};
      doc = await lib.getDocument({
        data: buf,
        cMapUrl: '/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/pdfjs/standard_fonts/',
      }).promise;
      page = await doc.getPage(1);
      // scale=1 的 viewport 就是 PDF 页面的点尺寸（1pt = 1px）；canvas 必须等于它 × scale。
      const base = page.getViewport({ scale: 1 });
      baseW = base.width;
      baseH = base.height;
      const viewport = page.getViewport({ scale: ${SCALE} });
      canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      dataUrl = canvas.toDataURL('image/png');
    } catch (e) {
      return { stage: 'render', error: String((e && (e.stack || e.message)) || e), picked, tried };
    }

    // 整幅间隔采样：既要确认画上了东西，也要确认不是一整块纯色
    //（应用外壳是深色的，所以"有非白像素"本身说明不了什么）。
    const all = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sampled = 0, nonWhite = 0, dark = 0, light = 0;
    for (let i = 0; i < all.length; i += 4 * 7) {
      sampled++;
      const lum = (all[i] * 299 + all[i + 1] * 587 + all[i + 2] * 114) / 1000;
      if (all[i] < 250 || all[i + 1] < 250 || all[i + 2] < 250) nonWhite++;
      if (lum < 96) dark++;
      if (lum > 160) light++;
    }
    return {
      stage: 'ok',
      picked,
      tried,
      worker: ${JSON.stringify(worker)},
      pdfBytes,
      numPages: doc.numPages,
      pageW: baseW,
      pageH: baseH,
      width: canvas.width,
      height: canvas.height,
      sampled,
      nonWhite,
      dark,
      light,
      dataUrl: dataUrl.length <= 6_000_000 ? dataUrl : null,
      dataUrlLength: dataUrl.length,
    };
  })()`;
}

async function main() {
  log('PNG 栅格化链路验收');

  const a4 = readA4();
  failures += check(a4 === 1123, `A4_HEIGHT_PX = ${a4}（期望 1123）`);

  const maxSide = readConst('CANVAS_MAX_SIDE');
  const maxArea = readConst('CANVAS_MAX_AREA');
  const memBudget = readConst('PEAK_MEMORY_BUDGET_MB');
  failures += check(maxSide === 65535, `CANVAS_MAX_SIDE = ${maxSide}`);
  failures += check(maxArea === 16384 * 16384, `CANVAS_MAX_AREA = ${maxArea}`);
  failures += check(memBudget === 800, `PEAK_MEMORY_BUDGET_MB = ${memBudget}`);

  // 长图页数上限：高度守卫与内存守卫取小。实测 1x→58、2x→29、3x→19。
  if (a4 && maxSide && memBudget) {
    const width = Math.round(a4 * (794 / 1123)); // A4 宽 ≈ 794
    const byHeight = (s) => Math.floor(maxSide / (a4 * s));
    const byMemory = (s) => Math.floor((memBudget * 1024 * 1024) / (width * s * a4 * s * 4));
    const limit = (s) => Math.min(byHeight(s), byMemory(s));
    const measured = [1, 2, 3].map(limit);
    failures += check(
      JSON.stringify(measured) === JSON.stringify([58, 29, 19]),
      `长图页数上限（1x/2x/3x）= ${measured.join(' / ')}（期望 58 / 29 / 19）`,
    );
  }

  // pdfjs 静态资源：这两个目录缺了，中文会渲染成空白。
  const cmaps = join(DIST, 'pdfjs', 'cmaps');
  const std = join(DIST, 'pdfjs', 'standard_fonts');
  failures += check(
    existsSync(cmaps) && readdirSync(cmaps).length > 0,
    `dist/pdfjs/cmaps 有 ${existsSync(cmaps) ? readdirSync(cmaps).length : 0} 个文件`,
  );
  failures += check(
    existsSync(std) && readdirSync(std).length > 0,
    `dist/pdfjs/standard_fonts 有 ${existsSync(std) ? readdirSync(std).length : 0} 个文件`,
  );

  const cand = candidates();
  failures += check(cand.modules.length > 0, `找到 pdfjs 分块：${cand.modules.join(', ')}`);
  failures += check(!!cand.worker, `找到 pdfjs worker：${cand.worker}`);
  if (!cand.worker || cand.modules.length === 0) {
    fail('pdfjs 分块不齐，页面内检查没法做');
    process.exit(1);
  }

  const r = await withApp(
    async ({ evaluate }) => {
      // ① 先让 Rust 真的打一份 PDF 出来。
      const ex = await evaluate(
        `(async () => {
          try {
            await window.__TAURI_INTERNALS__.invoke('export_pdf', { path: ${JSON.stringify(PDF_PATH)} });
            return { ok: true };
          } catch (e) {
            return { ok: false, error: (e && (e.message || e.kind)) || String(e) };
          }
        })()`,
        180_000,
      );
      if (!ex.ok) return { stage: 'export', error: ex.error };

      // ② 在 Node 侧读出来，再把字节喂给页面（不走静态资源服务）。
      if (!existsSync(PDF_PATH)) return { stage: 'export', error: `export_pdf 没有生成 ${PDF_PATH}` };
      const bytes = readFileSync(PDF_PATH);
      const head = bytes.subarray(0, 5).toString('latin1');
      if (!head.startsWith('%PDF-')) {
        return { stage: 'export', error: `产物不是 PDF，头 5 字节为 ${JSON.stringify(head)}` };
      }
      ok(`PDF 已生成：${(bytes.length / 1024).toFixed(1)} KB，头 ${head}`);
      return evaluate(rasterExpr(bytes.toString('base64'), cand.modules, cand.worker), 180_000);
    },
    { debug: true, timeoutMs: 60_000 },
  );

  if (r.stage !== 'ok') {
    failures += check(false, `页面内栅格化（阶段 ${r.stage}）`, r.error);
    if (r.tried) console.log(`     分块试探：${r.tried.join(' | ')}`);
  } else {
    ok(`pdfjs 分块选中 ${r.picked}，worker ${r.worker}`);
    failures += check(
      r.pdfBytes > 4096 && r.pdfBytes === statSync(PDF_PATH).size,
      `页面里解出的 PDF 字节 ${r.pdfBytes}（磁盘上 ${statSync(PDF_PATH).size}）`,
    );
    failures += check(r.numPages >= 1, `PDF 页数 ${r.numPages}`);

    // 纸张：导出走 WebView2 打印，尺寸必须落在 A4 上（595×842 pt，容差 3pt）。
    failures += check(
      Math.abs(r.pageW - 595) <= 3 && Math.abs(r.pageH - 842) <= 3,
      `PDF 页面尺寸 ${r.pageW?.toFixed(1)}×${r.pageH?.toFixed(1)} pt（期望 ≈595×842，即 A4）`,
    );

    // 分辨率：canvas 必须严格等于「页面点尺寸 × scale」，也就是 72dpi × scale。
    const expW = Math.round(r.pageW * SCALE);
    const expH = Math.round(r.pageH * SCALE);
    failures += check(
      Math.abs(r.width - expW) <= 1 && Math.abs(r.height - expH) <= 1,
      `canvas 尺寸 ${r.width}×${r.height}（= 页面 ${r.pageW?.toFixed(1)}×${r.pageH?.toFixed(1)}pt × ${SCALE}，期望 ${expW}×${expH}）`,
    );
    const dpi = r.height / (r.pageH / 72);
    ok(
      `等效分辨率 ${dpi.toFixed(0)} dpi（scale=${SCALE}；成品约 ${Math.round((r.pageW / 72) * 25.4)}×${Math.round((r.pageH / 72) * 25.4)} mm）`,
    );
    failures += check(r.width * r.height <= maxArea, `画布面积 ${r.width * r.height} 在 CANVAS_MAX_AREA 之内`);
    failures += check(r.height <= maxSide, `画布高度 ${r.height} 在 CANVAS_MAX_SIDE 之内`);

    // 打印的是应用外壳：深色底 + 浅色字，两者都要出现，免得"一整块纯色"也算过。
    failures += check(
      r.dark > 0 && r.light > 0,
      `整幅采样 ${r.sampled} 点：暗 ${r.dark} / 亮 ${r.light}（既有底色也有文字）`,
    );

    if (r.dataUrl) {
      const b64 = r.dataUrl.slice('data:image/png;base64,'.length);
      const bytes = Buffer.from(b64, 'base64');
      const sig = [...bytes.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      failures += check(sig === '89 50 4e 47 0d 0a 1a 0a', `PNG magic：${sig}`);
      const png = join(OUT, `page-1@${SCALE}x.png`);
      writeFileSync(png, bytes);
      const st = statSync(png);
      failures += check(st.size > 4096, `PNG 落盘 ${(st.size / 1024).toFixed(1)} KB → ${png}`);
    } else {
      warn(`data URL 太大（${(r.dataUrlLength / 1024 / 1024).toFixed(1)} MB），没落盘，只验了尺寸与像素`);
    }
  }

  if (failures) {
    fail(`${failures} 项未通过`);
    process.exit(1);
  }
  log('PNG 栅格化链路验收通过');
}

main().catch((e) => {
  fail(String(e?.stack || e));
  process.exit(1);
});
