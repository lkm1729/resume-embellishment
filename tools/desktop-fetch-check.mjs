#!/usr/bin/env node
/**
 * desktop-fetch-check.mjs —— 验证 Rust 侧的网页抓取命令 `fetch_url`。
 *
 * `fetch_url` 是给「用户贴一个招聘页面链接」这条路径用的：抓回来的是**纯文本**，
 * 正文抽取在 Rust 里做（`src-tauri/src/fetch.rs`，含去导航/去脚本/段落折叠）。
 * 它与 LLM 提供商那套 `reqwest` 客户端共用依赖，所以它通了，网络与 TLS 栈就是通的。
 *
 * 断言：
 *   - 正常页：返回 `{url,title,text,bytes,truncated}`，标题与正文非空；
 *   - 正文里**没有** `<script>` 里的源码（`fetch.rs` 的未闭合标签分支曾经
 *     把整段脚本粘回正文，这是个真 bug，这里钉住它）；
 *   - 死地址：以 `CommandError{kind,message}` 形式失败，而不是挂住或崩掉。
 *
 * 用法：node tools/desktop-fetch-check.mjs [--url=https://…]
 */
import { fail, log, ok, withApp } from './desktop-paths.mjs';

const URL_ARG = (process.argv.slice(2).find((a) => a.startsWith('--url=')) || '').slice(6);
const GOOD = URL_ARG || 'https://example.com/';
const DEAD = 'http://127.0.0.1:9/';

const EXPR = `(async () => {
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a || {});
  const attempt = async (c, a) => {
    try { return { ok: true, value: await inv(c, a) }; }
    catch (e) { return { ok: false, error: { kind: (e && e.kind) || null, message: (e && e.message) || String(e) } }; }
  };
  return {
    good: await attempt('fetch_url', { url: ${JSON.stringify(GOOD)} }),
    dead: await attempt('fetch_url', { url: ${JSON.stringify(DEAD)} }),
    shape: await attempt('fetch_url', {}),
  };
})()`;

let failures = 0;
function check(cond, label, detail) {
  if (cond) ok(label);
  else fail(`${label}${detail ? ` —— ${detail}` : ''}`);
  return cond ? 0 : 1;
}

async function main() {
  log(`抓取验收：${GOOD}`);
  const report = await withApp(
    async ({ evaluate }) => evaluate(EXPR),
    { debug: true, timeoutMs: 60_000 },
  );

  const good = report.good;
  if (!good.ok) {
    failures += check(false, '正常页抓取成功', `${good.error?.kind}: ${good.error?.message}`);
  } else {
    const v = good.value || {};
    failures += check(typeof v.url === 'string' && v.url.length > 0, `url 回填：${v.url}`);
    failures += check(typeof v.title === 'string' && v.title.length > 0, `标题：${v.title}`);
    failures += check(typeof v.text === 'string' && v.text.length > 50, `正文长度 ${v.text?.length} 字符`);
    failures += check(Number(v.bytes) > 0, `原始字节 ${v.bytes}`);
    failures += check(v.truncated === false || v.truncated === true, `truncated 是布尔：${v.truncated}`);
    failures += check(
      !/<script[\s>]/i.test(v.text || ''),
      '正文里没有 <script> 标签残留（fetch.rs 未闭合标签分支的回归守卫）',
    );
    failures += check(
      !/var\s+\w+\s*=\s*1/.test(v.text || ''),
      '正文里没有脚本源码残留',
    );
    const preview = (v.text || '').replace(/\s+/g, ' ').slice(0, 160);
    console.log(`     正文开头：${preview}`);
  }

  const dead = report.dead;
  failures += check(!dead.ok, '死地址会失败（而不是挂住）');
  if (!dead.ok) {
    failures += check(
      typeof dead.error?.message === 'string' && dead.error.message.length > 0,
      `错误带 message：${dead.error?.kind} / ${dead.error?.message}`,
    );
  }

  const shape = report.shape;
  failures += check(!shape.ok, '缺 url 参数会被拒绝');
  if (!shape.ok) ok(`拒绝原因：${shape.error?.kind} / ${shape.error?.message}`);

  if (failures) {
    fail(`${failures} 项未通过`);
    process.exit(1);
  }
  log('抓取验收通过');
}

main().catch((e) => {
  fail(String(e?.stack || e));
  process.exit(1);
});
