#!/usr/bin/env node
/**
 * release-smoke.mjs —— 交付前的冒烟验收。
 *
 * 它回答一个用户真正关心的问题：**双击这份 exe，窗口能不能起来。**
 *
 * 判断依据不是「进程还在」，而是 `crash.log` 里出现了 `启动完成` ——
 * Tauri 先建窗口、后建 webview，webview 创建失败时窗口会闪一下再消失，
 * 只看进程存活会把闪退误判成成功。这也是「弹出画面就闪退」这个现象的来源。
 *
 * 顺带检查的三件事：
 *   - 交付目录带不带低完整性标签（WebView2 起不来的直接原因）；
 *   - 交付目录里该有的文件是否齐全；
 *   - 有没有实例还占着 WebView2 的 user-data 目录。
 *
 * 用法：node tools/release-smoke.mjs  [--keep]  [--seconds=6]
 *   --keep      跑完不杀进程（留给你自己点进去看）
 *   --seconds=N 窗口要存活多少秒才算稳（默认 6）
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  DELIVER_DIR,
  DELIVER_MIRROR,
  EXE_NAME,
  countLiveAppInstances,
  fail,
  firstPanic,
  healFolder,
  inspectFolder,
  log,
  ok,
  pickLaunchableExe,
  preflight,
  resolveDesktopExe,
  spawnApp,
  stopApp,
  waitForReady,
  warn,
} from './desktop-paths.mjs';

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const SECONDS = Number((argv.find((a) => a.startsWith('--seconds=')) || '').split('=')[1] || 6);

/** 交付目录里除 exe 之外还应该存在的东西。 */
const EXPECTED = ['resume_embellishment_lib.dll', '修复-启动失败.cmd'];

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function human(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

/**
 * 选一份「平台干净」的 exe。
 * 工程内那份可能被工程根的低完整性标签污染，工程外镜像不会 —— 优先用能起的那份，
 * 但要让用户知道用的是哪一份。
 */
function pickExe() {
  const preferred = resolveDesktopExe();
  const wasLow = inspectFolder(dirname(preferred)).lowIntegrity;
  const picked = pickLaunchableExe();
  if (wasLow && picked === preferred) ok('已把继承重置为 Medium Mandatory Level');
  else if (wasLow) warn(`工程内交付目录带低完整性标签且修不动，改用工程外镜像：${picked}`);
  return picked;
}

function checkFolder(exePath) {
  const dir = dirname(exePath);
  let bad = 0;
  const st = statSync(exePath);
  ok(`${basename(exePath)}  ${human(st.size)}  ${st.mtime.toLocaleString('zh-CN')}`);
  ok(`sha256 ${sha256(exePath).slice(0, 16)}…`);
  for (const name of EXPECTED) {
    const p = join(dir, name);
    if (existsSync(p)) ok(`${name}  ${human(statSync(p).size)}`);
    else {
      warn(`缺 ${name}（不影响启动，但交付目录不完整）`);
      bad += 1;
    }
  }
  return bad;
}

async function main() {
  log('交付冒烟验收');
  const exePath = pickExe();
  const problems = checkFolder(exePath);

  const pre = preflight(exePath);
  if (pre.live > 0) {
    warn(`先清掉 ${pre.live} 个残留实例`);
    for (const p of pre.problems) console.log(`     ${p}`);
    const { killLiveAppInstances } = await import('./desktop-paths.mjs');
    killLiveAppInstances();
  } else if (!pre.safe) {
    for (const p of pre.problems) warn(p);
  }

  log(`启动 ${exePath}`);
  const child = spawnApp(exePath);
  let result;
  try {
    result = await waitForReady(exePath, 30_000);
  } catch (e) {
    fail(String(e.message || e));
    await stopApp(child);
    process.exit(1);
  }

  if (!result.ready) {
    fail(result.panicked ? '启动即崩溃' : result.timeout ? '30 s 内没等到「启动完成」' : '启动失败');
    const panic = firstPanic(result.tail || '');
    if (panic) console.log(`     ${panic}`);
    if (result.tail) console.log(result.tail.trim().split(/\r?\n/).slice(-6).map((l) => `     ${l}`).join('\n'));
    if (!KEEP) await stopApp(child);
    process.exit(1);
  }
  ok('日志出现「启动完成」');

  // 窗口建起来之后还要活着 —— 立刻退出同样是失败。
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  const live = countLiveAppInstances();
  if (live === 0) {
    fail(`存活 ${SECONDS} s 后进程已经不在，判为闪退`);
    if (!KEEP) await stopApp(child);
    process.exit(1);
  }
  ok(`存活 ${SECONDS} s，当前实例数 ${live}`);

  if (KEEP) {
    ok('--keep：进程留着不杀，可以直接点进去看');
  } else {
    const stopped = await stopApp(child);
    ok(stopped ? '已退出' : '退出不干净（残留实例会在下次启动时抢 user-data 目录）');
  }

  log(problems === 0 ? '冒烟通过' : `冒烟通过（${problems} 项交付目录缺件）`);
  if (existsSync(DELIVER_DIR) && existsSync(DELIVER_MIRROR)) {
    ok('两份交付目录都在：工程内 + 工程外镜像');
  }
}

main().catch((e) => {
  fail(String(e?.stack || e));
  process.exit(1);
});
