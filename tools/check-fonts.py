#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check-fonts.py —— 字体相关的一致性检查。三类问题各查一遍：

  1. **文档字体白名单**：`src/core/design/spec.ts` 里 `FONT_WHITELIST` 的每个家族
     在本机是否真的装上了。名单里有没装的字体是**静默**故障 —— 渲染层会悄悄
     回退到微软雅黑，用户在导出里看到的是别的字体。
     名单是**从源码里读的**，不是抄一份，所以白名单改了这里会跟着变。

  2. **界面字体子集**：`src/assets/fonts/` 下 5 个 .woff 是否存在、能不能打开、
     各有多少字形。

  3. **两套字体不能串**：Noto Sans SC / Google Sans Flex 这类界面字体**绝不能**出现在
     `FONT_WHITELIST` 里（文档字体只允许用系统自带字体），反过来
     `src/app/styles.css` 里每个 `@font-face` 的 src 文件都必须存在。

只读，不改任何文件。不需要管理员权限，也不起子进程（PowerShell 的
`spawnSync` 在受限沙箱下会 EPERM）。用法：`python tools/check-fonts.py`
"""
from __future__ import annotations

import io
import os
import re
import sys
import winreg

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SPEC = os.path.join(ROOT, "src", "core", "design", "spec.ts")
STYLES = os.path.join(ROOT, "src", "app", "styles.css")
FONT_DIR = os.path.join(ROOT, "src", "assets", "fonts")

# 界面字体，出现这些名字就说明两套字体被混在一起了。
UI_FONT_MARKERS = ("misans", "google sans", "noto sans sc")

FAILURES = 0


def ok(label: str) -> None:
    print(f"  [ok] {label}")


def bad(label: str, detail: str = "") -> None:
    global FAILURES
    FAILURES += 1
    print(f"  [!!] {label}" + (f" —— {detail}" if detail else ""))


def warn(label: str) -> None:
    print(f"  [--] {label}")


def read_text(path: str) -> str:
    with io.open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def parse_whitelist() -> list[str]:
    """从 spec.ts 里抠出 FONT_WHITELIST 的字面量。"""
    src = read_text(SPEC)
    m = re.search(r"FONT_WHITELIST\s*(?::[^=]*)?=\s*\[(.*?)\]", src, re.S)
    if not m:
        return []
    body = m.group(1)
    names = re.findall(r"['\"]([^'\"]+)['\"]", body)
    return [n.strip() for n in names if n.strip()]


def installed_families() -> set[str]:
    """从注册表收集本机已安装的字体家族名（大小写不敏感，去掉样式后缀）。"""
    families: set[str] = set()
    keys = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
    ]
    for hive, path in keys:
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(hive, path, 0, winreg.KEY_READ | view) as key:
                    count = winreg.QueryInfoKey(key)[1]
                    for i in range(count):
                        try:
                            value_name, _data, _type = winreg.EnumValue(key, i)
                        except OSError:
                            continue
                        families.add(value_name)
            except OSError:
                continue

    # 已安装字体目录里的文件名也当作线索（有些字体不进注册表）。
    fonts_dir = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    if os.path.isdir(fonts_dir):
        try:
            for name in os.listdir(fonts_dir):
                families.add(name)
        except OSError:
            pass

    normalized: set[str] = set()
    for raw in families:
        stem = os.path.splitext(raw)[0]
        # "Arial Bold (TrueType)" / "arialbd" 之类的尾巴都去掉
        stem = re.sub(r"\s*\((?:TrueType|OpenType|All res|VGA res)\)\s*$", "", stem, flags=re.I)
        stem = re.sub(r"\s+(?:Bold|Italic|Oblique|Light|Medium|Regular|Semibold|Semi Bold|"
                      r"Black|Thin|ExtraLight|ExtraBold|Condensed)(?:\s+(?:Italic|Oblique))?\s*$",
                      "", stem, flags=re.I)
        normalized.add(stem.strip().lower())
    return normalized


def family_installed(family: str, installed: set[str]) -> bool:
    want = family.strip().lower()
    if want in installed:
        return True
    # 用「文件名里包含家族名」兜底（比如 msyh -> 微软雅黑 这类是按注册表显示名匹配的）
    squashed = want.replace(" ", "")
    return any(squashed and squashed in cand.replace(" ", "") for cand in installed)


def check_whitelist() -> None:
    print("文档字体白名单（FONT_WHITELIST）")
    names = parse_whitelist()
    if not names:
        bad("没有从 src/core/design/spec.ts 解析出 FONT_WHITELIST")
        return
    installed = installed_families()
    print(f"     白名单 {len(names)} 项，本机注册表/字体目录收集到 {len(installed)} 个候选名")

    missing = []
    for name in names:
        if family_installed(name, installed):
            ok(f"{name} 已安装")
        else:
            missing.append(name)
            bad(f"{name} 没有装", "渲染层会静默回退到默认字体")
    if missing:
        print("     装不上的字体会让导出的版面悄悄换字体：要么装字体，要么从白名单里删掉。")

    # 两套字体不能串。
    for name in names:
        low = name.lower()
        if any(marker in low for marker in UI_FONT_MARKERS):
            bad(f"白名单里出现了界面字体：{name}", "导出的文档只允许用系统自带字体")


def check_subsets() -> None:
    print("界面字体子集（src/assets/fonts/）")
    if not os.path.isdir(FONT_DIR):
        bad("目录不存在", FONT_DIR)
        return
    files = sorted(f for f in os.listdir(FONT_DIR) if f.endswith(".woff"))
    if not files:
        bad("没有任何 .woff")
        return
    total = 0
    try:
        from fontTools.ttLib import TTFont
        have_fonttools = True
    except ImportError:
        have_fonttools = False

    for name in files:
        path = os.path.join(FONT_DIR, name)
        size = os.path.getsize(path)
        total += size
        if not have_fonttools:
            ok(f"{name} {size / 1024:.1f} KB（没有 fontTools，跳过结构检查）")
            continue
        try:
            font = TTFont(path)
            glyphs = len(font.getGlyphOrder())
            cmap = font.getBestCmap()
            has_name = "name" in font
            font.close()
            if cmap and has_name:
                ok(f"{name} {size / 1024:.1f} KB，{glyphs} 个字形，{len(cmap)} 个码位")
            else:
                bad(f"{name} 结构不完整", f"cmap={bool(cmap)} name={has_name}")
        except Exception as exc:  # noqa: BLE001
            bad(f"{name} 打不开", str(exc))
    print(f"     合计 {total / 1024:.1f} KB")


def check_styles() -> None:
    print("styles.css 的 @font-face 引用")
    if not os.path.exists(STYLES):
        bad("styles.css 不存在", STYLES)
        return
    css = read_text(STYLES)
    blocks = re.findall(r"@font-face\s*\{(.*?)\}", css, re.S)
    if not blocks:
        bad("styles.css 里没有 @font-face")
        return
    families = []
    for block in blocks:
        fam = re.search(r"font-family\s*:\s*['\"]([^'\"]+)['\"]", block)
        weight = re.search(r"font-weight\s*:\s*([^;]+);", block)
        srcs = re.findall(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)", block)
        label = fam.group(1) if fam else "(未命名)"
        weight_txt = weight.group(1).strip() if weight else "400"
        families.append((label, weight_txt))
        if not srcs:
            bad(f"{label} {weight_txt} 没有 src")
            continue
        for src in srcs:
            resolved = os.path.normpath(os.path.join(os.path.dirname(STYLES), src))
            if os.path.exists(resolved):
                rel = os.path.relpath(resolved, ROOT).replace("\\", "/")
                ok(f"{label} {weight_txt} → {rel}")
            else:
                bad(f"{label} {weight_txt} 的 src 指向不存在的文件", src)

    # 子集文件应当都被 @font-face 用上，别留孤儿。
    used = {
        os.path.basename(os.path.normpath(os.path.join(os.path.dirname(STYLES), s)))
        for block in blocks
        for s in re.findall(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)", block)
    }
    if os.path.isdir(FONT_DIR):
        for name in sorted(os.listdir(FONT_DIR)):
            if name.endswith(".woff") and name not in used:
                warn(f"{name} 没有被任何 @font-face 引用（多余文件）")

    lowered = [f.lower() for f, _ in families]
    if "noto sans sc" not in " ".join(lowered):
        warn("没有看到 Noto Sans SC 的 @font-face —— 界面中文会走系统字体")
    if "google sans" not in " ".join(lowered):
        warn("没有看到 Google Sans 的 @font-face —— 拉丁会走系统字体")


def main() -> int:
    print("==> 字体一致性检查")
    check_whitelist()
    check_subsets()
    check_styles()
    if FAILURES:
        print(f"==> {FAILURES} 项未通过")
        return 1
    print("==> 通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())