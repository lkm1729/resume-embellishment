import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  version: string;
};

/** 构建日期，`YYYYMMDD`（本地时区，因为用户看到的是本地日期）。 */
function buildStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: { '@': path.resolve(root, 'src') },
  },

  // 版本号与构建日期在这里固化 —— src/core/ui/version.ts 读取它们。
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_STAMP__: JSON.stringify(buildStamp()),
  },

  // Tauri 自己的终端输出不希望被 vite 清屏打断。
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],

  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Rust 侧由 cargo 自己 watch，vite 再扫一遍只会拖慢 HMR。
      ignored: ['**/src-tauri/**'],
    },
  },

  build: {
    // WebView2 跟着 Edge 走，固定一个足够新的基线即可。
    target: 'chrome105',
    // **保留 sourcemap**：源码曾经因为一次误删而只剩构建产物，
    // 是 src-tauri 的 codegen 资产 + sourcemap 把前端救回来的。
    sourcemap: true,
  },

  test: {
    include: ['src/**/*.test.ts'],
    // 重建期间测试文件尚未恢复，空跑不应该算失败。
    passWithNoTests: true,
  },
});
