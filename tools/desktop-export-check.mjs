#!/usr/bin/env node
/**
 * desktop-export-check.mjs —— 验证 Rust 侧的 PDF 导出通路真的能用。
 *
 * 它验的是**命令层**：`export_support` 报告支持 PDF，`export_pdf` 经
 * WebView2 的 `PrintToPdfAsync` 落下一个合法的矢量 PDF 文件。
 *
 * 它**不**验导出文档的版式 —— 那要求应用里已经有一份生成好的设计稿，
 * 而生成要走 LLM。命令层能过，说明「Rust 打印设置 → COM 回调 → 主线程 pump
 * → 文件落盘」这条最容易死锁的链路是通的（`recv()` 而不是 `wait_with_pump()`
 * 会永久挂住，这个脚本会以超时报出来）。
 *
 * 用法：node tools/desktop-export-check.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  fail,
  log,
  ok,
  resolveOutDir,
  withApp,
} from './desktop-paths.mjs';

const OUT = resolveOutDir('export-check');
const PDF = join(OUT, 'export.pdf');

/** 两段分开求值：`export_support` 是瞬时的，`export_pdf` 要等整篇打完，得单独放宽超时。 */
const HELPERS = `const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a || {});
  const attempt = async (c, a) => {
    try { return { ok: true, value: await inv(c, a) }; }
    catch (e) { return { ok: false, error: { kind: (e && e.kind) || null, message: (e && e.message) || String(e) } }; }
  };`;

const EXPR_SUPPORT = `(async () => { ${HELPERS}
  return { support: await attempt('export_support') };
})()`;

const EXPR_PRINT = `(async () => { ${HELPERS}
  const printed = await attempt('export_pdf', { path: ${JSON.stringify(PDF)} });
  return {
    printed,
    stillAlive: {
      root: !!document.getElementById('root'),
      text: (document.body.innerText || '').length,
      doc: document.querySelectorAll('.doc').length,
    },
  };
})()`;

/** 打印整篇文档可能要一两分钟，这里给足；Rust 侧自己的上限是 180 s。 */
const PRINT_TIMEOUT_MS = 150_000;

/** 从 PDF 字节里做最朴素的合法性检查。 */
function inspectPdf(path) {
  const buf = readFileSync(path);
  const head = buf.subarray(0, 8).toString('latin1');
  const tail = buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1');
  const text = buf.toString('latin1');
  const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  return {
    bytes: buf.length,
    header: head.trim(),
    hasEof: tail.includes('%%EOF'),
    vector: !/\/Subtype\s*\/Image/.test(text) || /\/FontFile/.test(text),
    pages,
    declaredCount: counts.length ? Math.max(...counts) : null,
  };
}

let failures = 0;
function check(cond, label, detail) {
  if (cond) ok(label);
  else fail(`${label}${detail ? ` —— ${detail}` : ''}`);
  return cond ? 0 : 1;
}

async function main() {
  log('PDF 导出通路验收（命令层）');
  const report = await withApp(
    async ({ evaluate }) => {
      // 分开两次求值：`export_pdf` 要等 WebView2 把整篇文档打完，不能和瞬时命令共用 15 s。
      const s = await evaluate(EXPR_SUPPORT);
      const p = await evaluate(EXPR_PRINT, PRINT_TIMEOUT_MS);
      return { support: s.support, printed: p.printed, stillAlive: p.stillAlive };
    },
    { debug: true, timeoutMs: 60_000 },
  );

  const support = report.support;
  check(support.ok, 'export_support 可调用', JSON.stringify(support.error || null));
  if (support.ok) {
    const v = support.value || {};
    check(v.pdf === true, `export_support.pdf = true`, JSON.stringify(v));
    check(typeof v.platform === 'string' && v.platform.length > 0, `platform = ${v.platform}`);
    if (v.note) console.log(`     备注：${v.note}`);
  }

  const printed = report.printed;
  if (!printed.ok) {
    failures += check(false, 'export_pdf 调用成功', `${printed.error?.kind}: ${printed.error?.message}`);
  } else {
    ok(`export_pdf 返回：${JSON.stringify(printed.value)}`);
    failures += check(existsSync(PDF), `PDF 落盘 ${PDF}`);
    if (existsSync(PDF)) {
      const st = statSync(PDF);
      const info = inspectPdf(PDF);
      failures += check(st.size > 4096, `文件大小合理：${(st.size / 1024).toFixed(1)} KB`);
      failures += check(/%PDF-\d\.\d/.test(info.header), `PDF 头：${info.header}`);
      failures += check(info.hasEof, 'PDF 尾部有 %%EOF（文件完整）');
      failures += check(info.pages > 0, `解析出 ${info.pages} 个页面对象` + (info.declaredCount ? `，/Count 声明 ${info.declaredCount}` : ''));
      failures += check(info.vector, '含字体/矢量内容（不是纯位图）');
      console.log(`     文件：${PDF}`);
    }
  }

  // 导出之后应用必须还在（导出视图要能切回来，不能让渲染器卡死）。
  const alive = report.stillAlive || {};
  failures += check(alive.root === true, 'export 之后 #root 仍在');
  failures += check((alive.text || 0) > 0, `界面仍有文字（${alive.text} 字符），说明渲染器没被卡死`);

  if (failures) {
    fail(`${failures} 项未通过`);
    process.exit(1);
  }
  log('导出通路验收通过');
}

main().catch((e) => {
  fail(String(e?.stack || e));
  process.exit(1);
});
