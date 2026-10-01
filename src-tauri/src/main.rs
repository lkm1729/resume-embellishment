// 发布版不弹控制台窗口；panic 文本改由 src/logging.rs 落盘。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    resume_embellishment_lib::run()
}
