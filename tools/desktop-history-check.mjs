#!/usr/bin/env node
/**
 * desktop-history-check.mjs —— 验证历史记录那 6 个 Rust 命令的接线、磁盘格式与校验。
 *
 * ⚠️ **这个脚本跑在用户真实的数据目录上**（`%APPDATA%\com.dsh.resume-embellishment\history.json`）。
 * 原因：Tauri 用 Windows 的「已知文件夹」API 解析配置目录，`APPDATA` 环境变量改不动它，
 * 所以做不了隔离。因此本脚本**刻意保持非破坏性**：
 *
 *   - 只读命令随便调：`list_history` / `get_history`；
 *   - `delete_history` / `delete_history_many` 只对**不存在的 id** 与**空列表**调用
 *     （后者按契约返回 0，什么都不删）；
 *   - 唯一的写入是「加一条自己造的记录 → 读回来 → 删掉它」，而且原样保留用户已有的条目，
 *     末尾还会断言条数回到开头的样子；
 *   - **绝不调用 `clear_history`。**
 *
 * 覆盖的关键契约（都是重建时踩过或差点踩到的）：
 *   - 磁盘格式是 `{"schema_version":1,"entries":[…]}` 的信封，**不是裸数组** ——
 *     按裸数组读会把用户已有文件判成「历史记录损坏」；
 *   - 不存在的 id 必须给 `CommandError{kind,message}`，而不是 panic；
 *   - 畸形 entry 必须被拒绝；
 *   - 一串命令之后进程还活着。
 *
 * 用法：node tools/desktop-history-check.mjs
 */
import { fail, log, ok, warn, withApp } from './desktop-paths.mjs';

const ENTRY_ID = 'h_smoke_check';

const EXPR = `(async () => {
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a || {});
  const attempt = async (c, a) => {
    try { return { ok: true, value: await inv(c, a) }; }
    catch (e) { return { ok: false, error: { kind: (e && e.kind) || null, message: (e && e.message) || String(e) } }; }
  };

  const before = await attempt('list_history');
  const beforeCount = before.ok && Array.isArray(before.value) ? before.value.length : null;

  // 只读 / 无副作用
  const missing = await attempt('get_history', { id: 'h_definitely_missing' });
  const delMissing = await attempt('delete_history', { id: 'h_definitely_missing' });
  const delNone = await attempt('delete_history_many', { ids: [] });
  const malformed = await attempt('add_history', { entry: {} });

  // 一次真正的增 → 查 → 列 → 删 回环；用固定 id，先清掉可能残留的同名记录。
  await attempt('delete_history', { id: ${JSON.stringify(ENTRY_ID)} });
  const entry = {
    id: ${JSON.stringify(ENTRY_ID)},
    docType: 'resume',
    createdAt: Date.now(),
    providerName: 'smoke',
    modelName: 'smoke',
    protocol: 'chat_completions',
    designSpec: {},
    contentSnapshot: [],
    contentHash: 'smoke',
  };
  const added = await attempt('add_history', { entry });
  const fetched = await attempt('get_history', { id: entry.id });
  const listed = await attempt('list_history');
  const inList = listed.ok && Array.isArray(listed.value) && listed.value.some((e) => e && e.id === entry.id);
  const removed = await attempt('delete_history', { id: entry.id });
  const afterGet = await attempt('get_history', { id: entry.id });

  const after = await attempt('list_history');
  const afterCount = after.ok && Array.isArray(after.value) ? after.value.length : null;

  return {
    beforeCount, beforeOk: before.ok, beforeError: before.error,
    missing, delMissing, delNone, malformed,
    added, fetchedOk: fetched.ok, fetchedId: fetched.ok ? fetched.value && fetched.value.id : null,
    inList, removed,
    afterGetExists: afterGet.ok,
    afterCount, afterOk: after.ok, afterError: after.error,
    alive: !!document.getElementById('root'),
  };
})()`;

let failures = 0;
function check(cond, label, detail) {
  if (cond) ok(label);
  else fail(`${label}${detail ? ` —— ${detail}` : ''}`);
  return cond ? 0 : 1;
}

/** 不存在的 id 必须给类型化错误，不能 panic、也不能返回裸字符串。 */
function typedError(result, label) {
  if (result.ok) {
    warn(`${label}：没有报错，返回 ${JSON.stringify(result.value)}`);
    return 0;
  }
  return check(
    typeof result.error?.message === 'string' && result.error.message.length > 0,
    `${label} → CommandError(${result.error?.kind})`,
    JSON.stringify(result.error),
  );
}

async function main() {
  log('历史记录命令验收（真实数据目录，只读为主）');
  const r = await withApp(async ({ evaluate }) => evaluate(EXPR), {
    debug: true,
    timeoutMs: 60_000,
  });

  // 1. 磁盘格式：能读出来就说明信封解析对了。
  if (!r.beforeOk) {
    failures += check(
      false,
      'list_history 读得动现有 history.json',
      `${r.beforeError?.kind}: ${r.beforeError?.message}`,
    );
  } else {
    failures += check(r.beforeCount !== null, 'list_history 返回数组', `beforeCount=${r.beforeCount}`);
    ok(`现有 ${r.beforeCount} 条记录（脚本结束时会回到这个数）`);
  }

  // 2. 错误契约
  failures += typedError(r.missing, 'get_history(不存在的 id)');
  failures += typedError(r.delMissing, 'delete_history(不存在的 id)');
  failures += typedError(r.malformed, 'add_history(畸形 entry)');
  if (r.delNone.ok) {
    failures += check(r.delNone.value === 0, `delete_history_many([]) 返回 0（实际 ${JSON.stringify(r.delNone.value)}）`);
  } else {
    failures += check(false, 'delete_history_many([]) 不该报错', JSON.stringify(r.delNone.error));
  }

  // 3. 完整回环
  if (!r.added.ok) {
    failures += check(false, 'add_history(合法 entry) 成功', JSON.stringify(r.added.error));
  } else {
    ok(`add_history 返回 ${JSON.stringify(r.added.value)}（因超上限被丢弃的条数）`);
    failures += check(r.fetchedOk && r.fetchedId === ENTRY_ID, 'get_history 读回同一条');
    failures += check(r.inList, 'list_history 里能看到它');
    failures += check(r.removed.ok, 'delete_history 成功', JSON.stringify(r.removed.error));
    failures += check(!r.afterGetExists, '删掉之后 get_history 又找不到了');
  }

  // 4. 收尾：条数必须回到开始的样子
  failures += check(r.afterOk, '一串命令之后 list_history 仍然可用（进程没崩）');
  if (r.beforeCount !== null && r.afterCount !== null) {
    failures += check(
      r.afterCount === r.beforeCount,
      `记录条数回到原样（${r.beforeCount} → ${r.afterCount}）`,
    );
  }
  failures += check(r.alive === true, '页面仍然挂载着 #root');

  if (failures) {
    fail(`${failures} 项未通过`);
    process.exit(1);
  }
  log('历史记录命令验收通过');
}

main().catch((e) => {
  fail(String(e?.stack || e));
  process.exit(1);
});
