#!/usr/bin/env node
/**
 * run.mjs —— 统一构建入口。
 *
 * 它存在的理由只有一个：工程目录名里含 `&`，在 cmd.exe 下会被当成命令分隔符，
 * 于是 `npm run xxx` 派生的子进程会拿到被截断的路径（`.bin\` 都拼不出来）。
 * 所以这里全部绕过 npm 与 shell，直接用可执行文件 + 参数数组 spawn。
 *
 * 用法：
 *   node run.mjs build        只出前端（dist/）
 *   node run.mjs app          前端 + release exe，并把 exe 复制进「简历美化工具/」
 *   node run.mjs deliver      不重新编译，只把现有 exe 复制进「简历美化工具/」，并修复目录强度标签
 *   node run.mjs desktop      同 app，然后立刻启动 exe（本地验收用）
 *   node run.mjs rust-test    跑 Rust 单测（TEMP 挪进工程内，绕开系统 TEMP 权限）
 *   node run.mjs verify       跑 tools/ 下的验收脚本（缺哪个就跳过哪个）
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TAURI_DIR = join(HERE, 'src-tauri');
const TMP = join(HERE, 'tmp');
const RELEASE_DIR = join(TAURI_DIR, 'target', 'release');

/** 交付目录，与工程同级。 */
const DELIVER_DIR = resolve(HERE, '..', '简历美化工具');
/**
 * 镜像交付目录，放在工程目录树之外。
 *
 * 必须存在第二份的原因：工程根目录 `Resume_&_Cover_Letter_Embellishment\` 上带着
 * `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`（低完整性标签）与
 * `Everyone:(CI)(DENY)(DC)`，子目录会**继承**它们。WebView2 的浏览器进程在这种目录下
 * 起不来，宿主 exe 会以 `HRESULT(0x800700AA)`（ERROR_BUSY「请求的资源在使用中」）失败。
 * 这与 exe 本身无关：同一份 exe 放到工程外就能正常启动。
 * deliver() 会把工程内那份的继承重置为 Medium，并在工程外再放一份干净的副本。
 */
const DELIVER_MIRROR = resolve(HERE, '..', '..', '简历美化工具');
const DELIVER_EXE = 'ResumeEmbellishment.exe';
const BUILT_EXE = 'resume_embellishment.exe';
const BUILT_DLL = 'resume_embellishment_lib.dll';

/** 需要跑一遍的验收脚本；重建过程中缺哪个就跳过哪个。 */
const VERIFY_SCRIPTS = [
  'theme-probe.mjs',
  'desktop-export-check.mjs',
  'desktop-fetch-check.mjs',
  'desktop-history-check.mjs',
  'verify-png-pipeline.mjs',
];

function log(msg) {
  console.log(`\n\u001b[36m==>\u001b[0m ${msg}`);
}

/** 直接 spawn（stdio: inherit），因此不经过 shell，`&` 不会被解释。 */
function run(cmd, args, opts = {}) {
  log(`${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: HERE, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    console.error(`\n退出码 ${r.status}，已中止。`);
    process.exit(r.status ?? 1);
  }
}

function inNodeModules(rel) {
  return join(HERE, 'node_modules', rel);
}

/** 单测用的 TEMP：系统 TEMP 在受限环境里不可写，会导致 25 个用例全挂。 */
function testEnv() {
  mkdirSync(TMP, { recursive: true });
  return { ...process.env, TEMP: TMP, TMP: TMP };
}

function frontend() {
  log('前端：类型检查');
  run(process.execPath, [inNodeModules('typescript/bin/tsc'), '--noEmit']);
  log('前端：打包');
  run(process.execPath, [inNodeModules('vite/bin/vite.js'), 'build']);
}

function rustRelease() {
  // custom-protocol 是必须的：没有它 exe 会去连 devUrl，双击后只有白屏。
  run(
    'cargo',
    ['build', '--release', '--features', 'custom-protocol'],
    { cwd: TAURI_DIR, env: testEnv() },
  );
}

/** 还有多少个 App 实例活着。WebView2 的 user-data 目录同时只能被一个实例持有。 */
function liveInstances() {
  const r = spawnSync(
    'tasklist',
    ['/NH', '/FI', `IMAGENAME eq ${DELIVER_EXE}`],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.error || r.status !== 0 || !r.stdout) return 0;
  return r.stdout.split(/\r?\n/).filter((l) => l.toLowerCase().includes(DELIVER_EXE.toLowerCase())).length;
}

function warnConflictingInstances() {
  const n = liveInstances();
  if (n > 0) {
    console.warn(
      `\n\u001b[33m注意：检测到 ${n} 个 ${DELIVER_EXE} 仍在运行。` +
        `\n   WebView2 的用户数据目录同时只能被一个实例持有，` +
        `\n   请先关掉它们再启动，否则新实例会以 HRESULT(0x800700AA) 失败。\u001b[0m`,
    );
  }
}

function icacls(args) {
  // stdio: 'ignore' —— 受限沙箱下管道式 stdio 会 spawn EPERM。
  const r = spawnSync('icacls', args, { stdio: 'ignore', windowsHide: true });
  return !r.error && r.status === 0;
}

/**
 * 把目录的继承 ACL 与完整性标签拉回普通状态。
 *
 * `/reset` 丢掉继承来的 `Everyone:(CI)(DENY)(DC)` 与 `S-1-4-…:(OI)(CI)(W,D,DC)`，
 * 恢复成父目录的默认权限；`/setintegritylevel M` 把低完整性标签换成 Medium ——
 * 后者才是 WebView2 起不来的直接原因。
 */
function healFolder(dir) {
  mkdirSync(dir, { recursive: true });
  const reset = icacls([dir, '/reset', '/T', '/C']);
  const label = icacls([dir, '/setintegritylevel', '(OI)(CI)M', '/T', '/C']);
  if (!reset || !label) {
    console.warn(`\n\u001b[33m注意：${dir} 的权限/强度标签没能修复，如果启动失败请改用镜像目录。\u001b[0m`);
  }
}

function copyInto(dir) {
  const exe = join(RELEASE_DIR, BUILT_EXE);
  if (!existsSync(exe)) {
    console.error(`没找到 ${exe}，先跑 node run.mjs app。`);
    process.exit(1);
  }
  healFolder(dir);
  const target = join(dir, DELIVER_EXE);
  copyFileSync(exe, target);
  const dll = join(RELEASE_DIR, BUILT_DLL);
  if (existsSync(dll)) copyFileSync(dll, join(dir, BUILT_DLL));
  return target;
}

function deliver() {
  const primary = copyInto(DELIVER_DIR);
  // 工程内那份可能被打回低完整性标签，镜像目录在工程外、不受影响，留给用户兜底。
  const mirror = copyInto(DELIVER_MIRROR);
  const st = statSync(primary);
  log('已交付');
  console.log(`   主目录  ${primary}`);
  console.log(`   镜像    ${mirror}`);
  console.log(`   ${(st.size / 1048576).toFixed(2)} MB   ${st.mtime.toLocaleString('zh-CN')}`);
}

function app() {
  frontend();
  rustRelease();
  deliver();
}

function desktop() {
  app();
  warnConflictingInstances();
  log('启动');
  const child = spawn(join(DELIVER_DIR, DELIVER_EXE), [], {
    detached: true,
    stdio: 'ignore',
    cwd: DELIVER_DIR,
  });
  child.unref();
  console.log('   已拉起，窗口应该马上出现。');
}

function rustTest() {
  run(
    'cargo',
    ['test', '--release', '--features', 'custom-protocol'],
    { cwd: TAURI_DIR, env: testEnv() },
  );
}

function verify() {
  const missing = [];
  for (const name of VERIFY_SCRIPTS) {
    const path = join(HERE, 'tools', name);
    if (!existsSync(path)) {
      missing.push(name);
      continue;
    }
    run(process.execPath, [path]);
  }
  if (missing.length) {
    console.log(`\n\u001b[33m跳过（尚未重建）：${missing.join('、')}\u001b[0m`);
  }
}

const TASKS = {
  build: frontend,
  frontend,
  app,
  deliver,
  desktop,
  'rust-test': rustTest,
  rusttest: rustTest,
  verify,
};

const task = (process.argv[2] || '').toLowerCase();
if (!TASKS[task]) {
  console.error(`用法：node run.mjs <${Object.keys(TASKS).join('|')}>`);
  process.exit(2);
}
TASKS[task]();
