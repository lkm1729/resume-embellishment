//! 读取本机已安装的**字体族**。
//!
//! # 为什么走 GDI，而不是查注册表
//!
//! `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts` 看起来是最省事的
//! 数据源，但它列的是**字体全名**而不是字体族：本机实测 230 条里有 116 条是
//! `Arial Bold` / `Calibri Bold Italic` 这类样式变体。把它们放进下拉框，
//! 用户选中 `Arial Bold` 之后 CSS 里写的 `font-family: "Arial Bold"`
//! 匹配不到任何字体族，浏览器会**静默回退**到别的字体 ——
//! 而这恰恰是「让用户自己选字体」这件事要避免的结果。
//!
//! 反过来，「把尾部的样式词去掉，剩下部分若也是个已知名字就丢弃」这种启发式
//! 又会误删真族：`Arial Narrow`、`Calibri Light`、`Candara Light`
//! 都是独立字体族，只是名字里恰好带了一个长得像样式词的词。
//!
//! `EnumFontFamiliesExW` 是 Windows 自己用来回答「这台机器上有哪些字体族」的
//! 接口，结果与系统字体设置面板一致：`Arial`、`Arial Narrow`、`Calibri Light`
//! 在列表里，`Arial Bold` 不在。所以这里直接问它，不自己拼启发式。
//!
//! # 调用方
//!
//! Tauri 命令 `list_system_fonts`（见 `lib.rs`），前端入口
//! `src/core/llm/api.ts` 的 `listSystemFonts()`。

use crate::error::{CommandError, Result};

/// 从定长 UTF-16 字段里取出字体名。
///
/// `lfFaceName` 是 `[u16; 32]`，以 NUL 结尾，而 NUL **之后可能还有内容**
/// （枚举缓冲区是复用的，尾部常常留着上一轮的字），所以必须按第一个 NUL
/// 截断。整个数组一把转成字符串会得到一个带尾巴的名字，写进 `font-family`
/// 谁也不认识，用户只会看到「选了没用」。
fn face_name(field: &[u16; 32]) -> String {
    let len = field
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(field.len());
    String::from_utf16_lossy(&field[..len]).trim().to_string()
}

/// 这个名字是不是一个可以直接写进 `font-family` 的字体族名。
///
/// 滤掉以 `@` 开头的：那是 CJK 字体的**竖排**变体（如 `@微软雅黑`），
/// 系统为同一套字额外注册的一份。选中它会让整段正文躺倒 90°。
fn is_usable_family(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('@')
}

#[cfg(windows)]
mod imp {
    use super::{face_name, is_usable_family, CommandError, Result};
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::Graphics::Gdi::{
        EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW, TMPF_TRUETYPE,
    };

    /// 把一个 `LPARAM` 当作 `&mut Vec<String>` 来用。
    ///
    /// `windows` crate 把这些 Win32 类型都包成了 newtype
    /// （`LPARAM(isize)`、`HDC(*mut c_void)`），所以取值要多一次 `.0`；
    /// 这是它与 `windows-sys` 最容易踩岔的地方。
    ///
    /// # Safety
    ///
    /// `lparam` 必须是当初作为 `LPARAM(&mut Vec<String>)` 传下去的那个指针，
    /// 且它所指向的 `Vec` 在返回的引用被用完之前不能被移动或释放。
    unsafe fn vec_from_lparam<'a>(lparam: LPARAM) -> &'a mut Vec<String> {
        &mut *(lparam.0 as *mut Vec<String>)
    }

    /// 每枚举到一个字体族就被调用一次。
    ///
    /// `lparam` 是我们自己传进去的 `*mut Vec<String>`；返回非零表示「继续枚举」，
    /// 返回 0 会立刻中止整轮枚举。
    ///
    /// # Safety
    ///
    /// 由 `EnumFontFamiliesExW` 调用，`lparam` 必须是我们传下去的那个指针。
    unsafe extern "system" fn collect_family(
        logfont: *const LOGFONTW,
        metric: *const TEXTMETRICW,
        _font_type: u32,
        lparam: LPARAM,
    ) -> i32 {
        // 文档保证这两个指针有效，但空指针解引用会直接把进程带走，
        // 而代价（用户看到一个转不完的圈、日志里一堆 panic）远高于一次判断。
        if logfont.is_null() || metric.is_null() || lparam.0 == 0 {
            return 1;
        }

        // 只要可缩放的轮廓字体。屏幕 DC 上 GDI 还会报出一批**设备字体** ——
        // `Fixedsys`、`Terminal`、`Small Fonts`、`MS Sans Serif` 这些点阵/矢量字。
        // 它们进了选择器就是陷阱：WebView2 走 DirectWrite 解析 `font-family`，
        // 一个也认不出来，选中只会静默回退到默认字体 ——
        // 正是本模块想消灭的那种"选了没反应"。
        // （把这一条去掉，`no_device_fonts_are_offered` 那个测试会红。）
        if !(*metric).tmPitchAndFamily.contains(TMPF_TRUETYPE) {
            return 1;
        }

        let name = face_name(&(*logfont).lfFaceName);
        if !is_usable_family(&name) {
            return 1;
        }

        let out = vec_from_lparam(lparam);
        // 同一个族会因为支持多个字符集而被回报多次（西文、GB2312、Big5…），
        // 这里去重。线性查找足够快：总量只有几百。
        if !out.iter().any(|seen| seen == &name) {
            out.push(name);
        }

        1
    }

    pub fn list_families() -> Result<Vec<String>> {
        let mut out: Vec<String> = Vec::new();

        // SAFETY: 所有指针都指向本帧内有效的栈上数据；回调只可能在
        // EnumFontFamiliesExW 返回之前被调用，那时 `out` 一定还活着。
        unsafe {
            // 传 None 取屏幕 DC：枚举字体既不画东西也不改设置，
            // 只是在问系统「你有哪些字体」。
            let hdc = GetDC(None);
            if hdc.0.is_null() {
                return Err(CommandError::io(
                    "拿不到用于枚举字体的设备上下文，无法读取系统字体列表。",
                ));
            }

            let mut lf = LOGFONTW::default();
            // 必须显式指定 DEFAULT_CHARSET。全零的 LOGFONTW 等于 ANSI_CHARSET，
            // 那样只会枚举出西文字体族，微软雅黑 / 宋体 / 楷体一个都不会出现 ——
            // 对一个中文简历工具来说，那等于没有字体可选。
            lf.lfCharSet = DEFAULT_CHARSET;

            EnumFontFamiliesExW(
                hdc,
                &lf,
                Some(collect_family),
                LPARAM(&mut out as *mut Vec<String> as isize),
                0,
            );

            ReleaseDC(None, hdc);
        }

        // 按不区分大小写的名字排序。字体列表是用来「按名字找」的，
        // 大小写混排（`arrow` 排在 `Zapf` 后面）会让找 Arial 变成翻半页。
        out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));

        Ok(out)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{CommandError, Result};

    pub fn list_families() -> Result<Vec<String>> {
        Err(CommandError::new(
            "unsupported",
            "只有 Windows 上才能读取系统字体列表。",
        ))
    }
}

/// 列出本机已安装的字体族名，按名字排序。
pub fn list_families() -> Result<Vec<String>> {
    imp::list_families()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把字符串写进定长 UTF-16 字段。
    fn field_of(name: &str) -> [u16; 32] {
        let mut field = [0u16; 32];
        for (i, c) in name.encode_utf16().enumerate() {
            field[i] = c;
        }
        field
    }

    #[test]
    fn a_face_name_stops_at_the_first_nul() {
        let mut field = field_of("Arial");
        // 模拟复用缓冲区里残留的上一轮内容。
        // ⚠ 必须写在索引 6 之后：`field_of("Arial")` 把 5 个字符放在 0..=4，
        // 索引 5 就是那个 NUL。一开始写到 5 上，等于亲手把终止符抹掉，
        // 断言拿到的是 "ArialZZ" —— 那是测试写错了，不是截断逻辑错了。
        field[6] = 'Z' as u16;
        field[7] = 'Z' as u16;
        assert_eq!(face_name(&field), "Arial");
    }

    #[test]
    fn a_face_name_that_fills_the_field_is_kept_whole() {
        // 名字正好占满 32 个单元、没有 NUL 时不能少读。
        let mut field = [b'x' as u16; 32];
        assert_eq!(face_name(&field).len(), 32);
        field[31] = 0;
        assert_eq!(face_name(&field).len(), 31);
    }

    #[test]
    fn an_empty_field_gives_an_empty_name() {
        assert_eq!(face_name(&[0u16; 32]), "");
    }

    #[test]
    fn chinese_family_names_survive_the_utf16_round_trip() {
        assert_eq!(face_name(&field_of("微软雅黑")), "微软雅黑");
    }

    #[test]
    fn vertical_variants_are_not_offered() {
        // `@微软雅黑` 是同一套字的竖排版本，选中会让正文整列躺倒。
        assert!(!is_usable_family("@微软雅黑"));
        assert!(!is_usable_family(""));
        assert!(is_usable_family("微软雅黑"));
        // 名字里带 `Narrow` 的是**独立字体族**，不是样式变体，必须留下 ——
        // 这正是「注册表 + 去样式词」那套启发式会误删的例子。
        assert!(is_usable_family("Arial Narrow"));
        assert!(is_usable_family("Calibri Light"));
    }

    #[cfg(windows)]
    #[test]
    fn the_real_system_list_has_families_and_no_style_variants() {
        let fonts = list_families().expect("应当能读到系统字体");

        assert!(
            fonts.len() > 50,
            "只读到 {} 个字体族，太少了，枚举大概没生效",
            fonts.len()
        );
        assert!(fonts.iter().any(|f| f == "Arial"), "缺少 Arial");

        // 中文字体族必须在。漏掉它们，中文简历就没有字体可选 ——
        // 而 DEFAULT_CHARSET 写错时正是这个症状。
        assert!(
            fonts.iter().any(|f| f.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))),
            "列表里没有任何中文字体族，字符集大概被限制成了 ANSI"
        );

        // 这条是整个模块存在的理由：注册表会给 `Arial Bold`，
        // 而它不是字体族，选中后会静默回退到别的字体。
        assert!(
            !fonts.iter().any(|f| f == "Arial Bold"),
            "样式变体混进了字体族列表"
        );
        assert!(
            !fonts.iter().any(|f| f.starts_with('@')),
            "竖排变体混进了字体族列表"
        );

        // 屏幕 DC 会额外报出一批 GDI 设备字体。它们是点阵或矢量字，
        // DirectWrite 一个都解析不了，进了选择器就是"选了没反应"。
        for device_font in ["Fixedsys", "Terminal", "Small Fonts", "MS Serif", "MS Sans Serif"] {
            assert!(
                !fonts.iter().any(|f| f == device_font),
                "设备字体 {device_font} 混进了字体族列表"
            );
        }

        // 去重必须彻底：重复项会在下拉框里出现两次，看起来像 bug。
        let mut sorted = fonts.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), fonts.len(), "字体族列表里有重复项");
    }
}
