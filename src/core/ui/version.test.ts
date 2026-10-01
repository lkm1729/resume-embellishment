import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION, BUILD_STAMP, VERSION_LABEL, prettyStamp } from './version';

const ROOT = join(__dirname, '..', '..', '..');

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Record<string, unknown>;
}

/**
 * 三处版本号必须一致。
 *
 * 它们各自被不同的东西读：`package.json` 进前端（经 Vite 的 `define`），
 * `tauri.conf.json` 决定安装包与「关于」里的版本，`Cargo.toml` 决定 exe 的
 * 文件版本资源。任何一处落后都会让用户看到两个不同的版本号。
 */
describe('版本号一致性', () => {
  const pkg = readJson('package.json');
  const tauri = readJson('src-tauri/tauri.conf.json');
  const cargo = readFileSync(join(ROOT, 'src-tauri', 'Cargo.toml'), 'utf8');

  it('package.json 与 tauri.conf.json 相同', () => {
    expect(pkg.version).toBe(tauri.version);
  });

  it('Cargo.toml 与 package.json 相同', () => {
    const m = /^version\s*=\s*"([^"]+)"/m.exec(cargo);
    expect(m?.[1]).toBe(pkg.version);
  });

  it('注入到前端的版本号与 package.json 相同', () => {
    expect(APP_VERSION).toBe(pkg.version);
  });
});

describe('版本号展示', () => {
  it('版本与日期之间有一个空格', () => {
    expect(VERSION_LABEL).toBe(`V${APP_VERSION} (${BUILD_STAMP})`);
    expect(VERSION_LABEL).toMatch(/^V\d+\.\d+\.\d+ \(\d{8}\)$/);
  });

  it('构建日期是 8 位 YYYYMMDD', () => {
    expect(BUILD_STAMP).toMatch(/^\d{8}$/);
  });

  it('prettyStamp 把 YYYYMMDD 变成 YYYY-MM-DD', () => {
    expect(prettyStamp('20260930')).toBe('2026-09-30');
  });

  it('prettyStamp 遇到非 8 位输入原样返回', () => {
    expect(prettyStamp('dev')).toBe('dev');
  });
});
