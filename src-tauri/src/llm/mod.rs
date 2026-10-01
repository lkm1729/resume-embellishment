//! 第三方 LLM 调用。
//!
//! ⚠ 全部经 Rust 侧发出。CSP 的 `connect-src` 只允许 `self` 与 `ipc`，
//! 前端根本连不出去 —— 这不是疏漏，是刻意的：
//! 附带的好处是 API Key 不必进入 webview，也就不可能被页面里的
//! 任何脚本读到。

pub mod client;
pub mod types;
