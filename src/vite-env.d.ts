/// <reference types="vite/client" />

/**
 * 由 vite.config.ts 的 `define` 在**构建时**替换成字面量。
 *
 * 为什么不用 Tauri 的 `getVersion()`：它拿得到版本号，但拿不到**构建日期**，
 * 而日期只能在构建期固化。既然日期非注入不可，版本号就从同一条路径取。
 */
declare const __APP_VERSION__: string;
declare const __BUILD_STAMP__: string;
