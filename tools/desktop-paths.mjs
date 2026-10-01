#!/usr/bin/env node
/**
 * 桌面验收脚本的共用工具。
 *
 * 这里集中处理三件在其它脚本里重复出现、且都踩过坑的事：
 *
 * 1. **找 exe**。交付目录有两份（工程内 / 工程外镜像），还有一份编译产物。
 *    绝对不要写死路径：工程目录名含 `&`，写死的路径在 shell 里会被截断。
 *
 * 2. **读 crash.log 必须显式 UTF-8**。PowerShell 的 `Get-Content -Raw` 在本机
 *    按 GBK 解码，中文标记会变成乱码，于是「启动完成」永远匹配不到 —— 这个坑
 *    造成过一整轮误判。Node 的 `readFileSync(p, 'utf8')` 没有这个问题。
 *
 * 3. **启动前检查目录的完整性标签**。工程根带
 *    `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，子目录继承它。
 *    exe 位于低完整性标签目录下时 WebView2 起不来，宿主会以
 *    `HRESULT(0x800700AA)`（ERROR_BUSY，「请求的资源在使用中」）失败 ——
 *    错误码具有误导性，实际没有任何进程占用 user-data 目录。
 *    修复用 `icacls <dir> /reset /T /C` + `/setintegritylevel "(OI)(CI)M" /T /C`。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '..');
/** 交付目录（工程内，可能带低完整性标签）。 */
export const DELIVER_DIR = resolve(PROJECT_ROOT, '..', '简历美化工具');
/** 镜像交付目录（工程外，标签干净）。 */
export const DELIVER_MIRROR = resolve(PROJECT_ROOT, '..', '..', '简历美化工具');
export const RELEASE_DIR = join(PROJECT_ROOT, 'src-tauri', 'target', 'release');

export const EXE_NAME = 'ResumeEmbellishment.exe';
export const BUILT_EXE = 'resume_embellishment.exe';
export const CRASH_LOG_NAME = 'crash.log';

/** logging.rs 里写下的标记，改动它们必须同步改 `src-tauri/src/logging.rs`。 */
export const START_MARK = '===== 启动';
export const READY_MARK = '启动完成';
export const EXIT_MARK = '正常退出';
export const PANIC_MARK = '!!! 崩溃 !!!';

/** CDP 调试端口。WebView2 需要 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 才会开。 */
export const DEBUG_PORT = Number(process.env.RE_DEBUG_PORT || 9333);

export function log(msg) {
  console.log(`\u001b[36m==>\u001b[0m ${msg}`);
}
export function ok(msg) {
  console.log(`\u001b[32m  ok\u001b[0m ${msg}`);
}
export function warn(msg) {
  console.log(`\u001b[33m  !! \u001b[0m${msg}`);
}
export function fail(msg) {
  console.log(`\u001b[31m  xx \u001b[0m${msg}`);
}

/**
 * 找到一份可以双击的 exe，按「工程内交付 → 工程外镜像 → 编译产物」的顺序。
 * 优先交付目录：那才是用户实际会点的那一份。
 */
export function resolveDesktopExe() {
  const candidates = [
    join(DELIVER_DIR, EXE_NAME),
    join(DELIVER_MIRROR, EXE_NAME),
    join(RELEASE_DIR, BUILT_EXE),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`找不到可执行文件，试过：\n  ${candidates.join('\n  ')}`);
}

/** 验收产物落点：`<工程>/out/<name>/`，跑完的截图、JSON、PNG 都放这里。 */
export function resolveOutDir(name) {
  const dir = join(PROJECT_ROOT, 'out', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 始终以 UTF-8 读取。 */
export function readText(path) {
  return readFileSync(path, 'utf8');
}

/** 读 exe 旁的 crash.log；不存在时返回空串。 */
export function readCrashLog(exePath) {
  const p = join(dirname(exePath), CRASH_LOG_NAME);
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export function crashLogPath(exePath) {
  return join(dirname(exePath), CRASH_LOG_NAME);
}

function tasklist() {
  const r = spawnSync('tasklist', ['/NH', '/FI', `IMAGENAME eq ${EXE_NAME}`], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error || r.status !== 0 || !r.stdout) return '';
  return r.stdout;
}

/** 还有几个 App 实例活着。WebView2 的 user-data 目录同时只能被一个实例持有。 */
export function countLiveAppInstances() {
  return tasklist()
    .split(/\r?\n/)
    .filter((l) => l.toLowerCase().includes(EXE_NAME.toLowerCase())).length;
}

export function killLiveAppInstances() {
  const n = countLiveAppInstances();
  if (n > 0) spawnSync('taskkill', ['/IM', EXE_NAME, '/F'], { stdio: 'ignore', windowsHide: true });
  return n;
}

/**
 * 读一个目录的强制完整性标签与显式拒绝项。
 * 返回 `{ raw, lowIntegrity, mediumIntegrity, denied }`。
 */
export function inspectFolder(dir) {
  const r = spawnSync('icacls', [dir], { encoding: 'utf8', windowsHide: true });
  const raw = r.status === 0 && r.stdout ? r.stdout : '';
  return {
    raw,
    lowIntegrity: /Low Mandatory Level/i.test(raw),
    mediumIntegrity: /Medium Mandatory Level/i.test(raw),
    denied: /\(DENY\)/i.test(raw),
  };
}

/** 用 icacls 把继承与完整性标签拉回普通状态。 */
export function healFolder(dir) {
  mkdirSync(dir, { recursive: true });
  spawnSync('icacls', [dir, '/reset', '/T', '/C'], { stdio: 'ignore', windowsHide: true });
  spawnSync('icacls', [dir, '/setintegritylevel', '(OI)(CI)M', '/T', '/C'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

/**
 * 启动前的体检：低完整性标签 / 存活实例 / 目录存在。
 * 返回 `{ safe, problems[] }`，调用方自己决定是修还是退。
 */
export function preflight(exePath = resolveDesktopExe()) {
  const dir = dirname(exePath);
  const problems = [];
  if (!existsSync(exePath)) problems.push(`找不到 ${exePath}`);

  const info = inspectFolder(dir);
  if (info.lowIntegrity) {
    problems.push(
      `${dir} 带低完整性标签（Low Mandatory Level），WebView2 会以 HRESULT(0x800700AA) 启动失败。` +
        `修复：icacls "${dir}" /reset /T /C 且 icacls "${dir}" /setintegritylevel "(OI)(CI)M" /T /C`,
    );
  }
  const live = countLiveAppInstances();
  if (live > 0) problems.push(`有 ${live} 个 ${EXE_NAME} 还在跑，WebView2 的 user-data 目录同时只能被一个实例持有`);
  return { safe: problems.length === 0, problems, folder: info, live };
}

/** 选一份「平台干净」、现在就能起来的 exe：优先工程内交付，标签坏了就修，修不动才退回镜像。 */
export function pickLaunchableExe() {
  const preferred = resolveDesktopExe();
  const dir = dirname(preferred);
  if (!inspectFolder(dir).lowIntegrity) return preferred;
  healFolder(dir);
  if (!inspectFolder(dir).lowIntegrity) return preferred;
  const mirror = join(DELIVER_MIRROR, EXE_NAME);
  return existsSync(mirror) ? mirror : preferred;
}

/*
 * 这里**没有** `isolatedEnv()`。
 *
 * 一开始写过一版：把子进程的 `APPDATA` / `LOCALAPPDATA` 指到 `out/<name>/`，
 * 想用一次性数据目录做隔离。**它是无效的** —— Tauri（以及它用的 `dirs`）在 Windows 上
 * 通过「已知文件夹」API（`SHGetKnownFolderPath`）解析配置与数据目录，根本不看这两个环境变量。
 * 实测：注入了环境变量之后，应用仍然读写了真实的
 * `C:\Users\<user>\AppData\Roaming\com.dsh.resume-embellishment\history.json`。
 *
 * 结论：**验收脚本跑在用户真实的数据目录上**，所以每一个脚本都必须是非破坏性的，
 * 绝不能调用 `clear_history` 这类会清空用户数据的命令。
 */

/**
 * 启动 App。默认不附加调试参数，`debug: true` 时打开 CDP 端口。
 *
 * `env` 用来给子进程注入额外环境变量。验收脚本靠它把 `APPDATA` / `LOCALAPPDATA`
 * 指到 `out/` 里，这样读写历史与 WebView2 profile 都不会碰用户的真实数据。
 */
export function spawnApp(exePath = resolveDesktopExe(), opts = {}) {
  const { debug = false, detached = false, env: extraEnv = null } = opts;
  const env = { ...process.env };
  if (extraEnv) Object.assign(env, extraEnv);
  if (debug) {
    // 不同的浏览器参数必须配不同的 user-data 目录；这里保证同一时刻只有一个实例，
    // 所以不需要额外改目录。
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${DEBUG_PORT} --remote-allow-origins=*`;
  } else {
    delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  }
  const child = spawn(exePath, [], {
    cwd: dirname(exePath),
    env,
    detached,
    stdio: 'ignore',
    windowsHide: false,
  });
  if (detached) child.unref();
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等日志里出现 `启动完成`。
 *
 * 注意日志是**追加**的：先把启动前的长度记下来，只在新增部分里找标记，
 * 否则上一次运行的 `启动完成` 会被当成本次成功。
 */
export async function waitForReady(exePath, timeoutMs = 30_000) {
  const path = crashLogPath(exePath);
  const beforeSize = existsSync(path) ? statSync(path).size : 0;
  const beforeText = existsSync(path) ? readText(path) : '';
  const deadline = Date.now() + timeoutMs;
  let tail = '';
  while (Date.now() < deadline) {
    if (existsSync(path) && statSync(path).size > beforeSize) {
      // 注意：`beforeSize` 是**字节**数，而这里拿到的是**解码后的字符串**。
      // 日志里有中文，一个汉字 3 字节但只有 1 个 UTF-16 码元，所以
      // `text.slice(beforeSize)` 会切到新内容之后 —— 标记明明写了却看不见。
      // 正确的做法是按「上一次读到的整段文本」做前缀比对。
      const whole = readText(path);
      const fresh = whole.startsWith(beforeText) ? whole.slice(beforeText.length) : whole;
      tail = fresh;
      if (fresh.includes(READY_MARK)) return { ready: true, tail: fresh };
      if (fresh.includes(PANIC_MARK)) return { ready: false, tail: fresh, panicked: true };
    }
    await sleep(250);
  }
  // 超时的时候把「基线长度 / 现在的长度 / 整个文件里到底有没有标记」一并带出去。
  // 没有这几个数字，就只能猜是应用没起来、还是脚本读错了文件。
  const nowSize = existsSync(path) ? statSync(path).size : 0;
  const whole = existsSync(path) ? readText(path) : '';
  return {
    ready: false,
    tail,
    timeout: true,
    diag: {
      path,
      before: beforeSize,
      nowSize,
      hasReadyAnywhere: whole.includes(READY_MARK),
      hasStartAnywhere: whole.includes(START_MARK),
    },
  };
}

/** 从日志文本里抽出第一条 panic 行，用于报告。 */
export function firstPanic(text) {
  const line = text.split(/\r?\n/).find((l) => l.includes('panicked at'));
  return line ? line.trim() : '';
}

/** 极简 CDP 客户端。Node 24 自带全局 WebSocket，不需要任何依赖。 */
export async function connectCdp(port = DEBUG_PORT, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
      if (target) break;
    } catch {
      /* 端口还没起来 */
    }
    await sleep(300);
  }
  if (!target) throw new Error(`CDP 端口 ${port} 在 ${timeoutMs} ms 内没有出现`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), 10_000);
    ws.addEventListener('open', () => {
      clearTimeout(to);
      res();
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(to);
      rej(new Error(`CDP WebSocket 出错：${e?.message || e?.type || 'unknown'}`));
    });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.rej(new Error(msg.error.message || JSON.stringify(msg.error)));
    else p.res(msg.result);
  });

  function send(method, params = {}, timeoutMs = 15_000) {
    const id = ++seq;
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) rej(new Error(`${method} 超时（${timeoutMs / 1000} s）`));
      }, timeoutMs);
    });
  }

  /**
   * 在页面里求值。`timeoutMs` 可以按调用放宽 —— 有些命令天然慢：
   * `export_pdf` 要等 WebView2 把整篇文档打完，15 s 是打不完的。
   */
  async function evaluate(expression, timeoutMs = 15_000) {
    const r = await send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const ex = d.exception || {};
      // 压缩过的库（比如 pdfjs）抛出来的 `description` 常常只是一个短标识符，
      // 所以把 text / 行列号 / url 一起带上，否则只看到一个 "ne" 没法查。
      const parts = [
        ex.description || ex.value || d.text || '页面内求值抛错',
        d.text && d.text !== (ex.description || ex.value) ? `（${d.text}）` : null,
        Number.isFinite(d.lineNumber) ? `@${d.lineNumber}:${d.columnNumber}` : null,
        d.url || null,
      ].filter(Boolean);
      throw new Error(parts.join(' '));
    }
    return r.result?.value;
  }

  return {
    evaluate,
    target,
    close() {
      try {
        ws.close();
      } catch {
        /* 已经关了 */
      }
    },
  };
}

/**
 * 一次完整的验收生命周期：选 exe → 清残留实例 → 启动 → 等「启动完成」→
 * 可选连 CDP → 跑回调 → 收尾。
 *
 * 回调拿到 `{ exePath, cdp, evaluate }`。`evaluate` 直接吃一段表达式字符串，
 * 在页面里以 `returnByValue` 求值 —— 于是在页面里就能调 `__TAURI_INTERNALS__.invoke`，
 * 不必去点 UI。这样验收的是**真实的 Rust 命令**，而不是我对选择器的猜测。
 */
export async function withApp(fn, opts = {}) {
  const {
    debug = false,
    keep = false,
    timeoutMs = 30_000,
    env = null,
    exePath: forcedExe = null,
  } = opts;
  const exePath = forcedExe || pickLaunchableExe();
  const pre = preflight(exePath);
  if (pre.live > 0) {
    warn(`有 ${pre.live} 个实例还在跑，先清掉（WebView2 的 user-data 目录同时只能被一个实例持有）`);
    killLiveAppInstances();
  }
  for (const p of pre.problems) if (!p.includes('还在跑')) warn(p);

  const child = spawnApp(exePath, { debug, env });
  let cdp = null;
  try {
    const ready = await waitForReady(exePath, timeoutMs);
    if (!ready.ready) {
      const panic = firstPanic(ready.tail || '');
      throw new Error(
        (ready.panicked ? '应用启动即崩溃' : `${timeoutMs / 1000} s 内没等到「启动完成」`) +
          (panic ? `\n     ${panic}` : '') +
          (ready.diag
            ? `\n     日志 ${ready.diag.path}\n     基线 ${ready.diag.before} → 现在 ${ready.diag.nowSize} 字节` +
              `，全文件含「启动」=${ready.diag.hasStartAnywhere}，含「启动完成」=${ready.diag.hasReadyAnywhere}`
            : ''),
      );
    }
    if (debug) cdp = await connectCdp();
    return await fn({
      exePath,
      cdp,
      evaluate: cdp ? (expr, ms) => cdp.evaluate(expr, ms) : null,
    });
  } finally {
    if (cdp) cdp.close();
    if (!keep) await stopApp(child);
  }
}

/** 关掉 App 并等它真的退出。 */
export async function stopApp(child, timeoutMs = 8_000) {
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {
      /* 已经退了 */
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countLiveAppInstances() === 0) return true;
    await sleep(200);
  }
  killLiveAppInstances();
  return countLiveAppInstances() === 0;
}

export { sleep };
