#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-fonts.py —— 从源字体生成 src/assets/fonts/ 下的界面字体子集。

界面字体与文档字体是两套东西：这里的 Noto Sans SC / Google Sans Flex 只服务应用外壳，
**永远不会**进入 `FONT_WHITELIST`（导出的简历/求职信只用 Windows 自带字体）。

它做三件事：
  1. 把 Google Sans Flex（六轴可变字体）实例化出 400 / 500 / 600 三个静态字重；
  2. 把 Noto Sans SC（wght 可变字体）实例化成 400 / 600，再裁到「界面里真正会用到的字符」；
  3. 输出 `.woff`（不是 woff2 —— woff2 要 brotli，本机没这个模块）。

字符集怎么定：
  - `ui`   —— 扫 `src/` 下所有 .ts/.tsx/.html/.css，把出现过的字符都收进来。
             界面文案改了字，重跑一次这个脚本就能把新字带进子集。
  - `gb2312-l1` —— GB2312 一级字库 3755 个字（第 16–55 区）。Regular 带上它，
             这样任何常规中文界面文案都不会掉字。Semibold 只带 `ui`
             （它只用于标题，掉字会回退到 Regular）。

授权：两套字体都是 SIL OFL 1.1。Noto Sans SC 的保留字体名（RFN）是 “Source”
（它派生自 Source Han Sans），本项目只做子集化、没有使用该名字。
版权声明与许可证原文见仓库根的 `NOTICE.md`。

用法：
  python tools/build-fonts.py                 # 源字体放在 tools/fonts-src/
  python tools/build-fonts.py --src D:\fonts  # 指定源目录
  python tools/build-fonts.py --check         # 只报告产物，不重新生成
"""
from __future__ import annotations

import argparse
import glob
import io
import os
import re
import sys
import unicodedata

# 本机 stdout 是 GBK，中文会炸；统一换成 UTF-8 并把不可编码字符替换掉。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover - 老 Python 或重定向场景
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC_DIR = os.path.join(ROOT, "src")
OUT_DIR = os.path.join(SRC_DIR, "assets", "fonts")

# 界面里可能出现的字符：ASCII、拉丁补充、常用标点/符号、CJK、全角形式、箭头等。
KEEP_RANGES = [
    (0x0020, 0x007E),  # ASCII 可见字符
    (0x00A0, 0x00FF),  # 拉丁补充
    (0x2000, 0x206F),  # 常用标点
    (0x20A0, 0x20BF),  # 货币符号
    (0x2100, 0x214F),  # 字母式符号
    (0x2190, 0x21FF),  # 箭头
    (0x2200, 0x22FF),  # 数学运算符
    (0x2500, 0x257F),  # 制表符
    (0x25A0, 0x25FF),  # 几何图形
    (0x2600, 0x26FF),  # 杂项符号（☀ ☾ 这类主题图标）
    (0x3000, 0x303F),  # CJK 标点
    (0x4E00, 0x9FFF),  # CJK 统一表意文字
    (0xFE30, 0xFE4F),  # CJK 兼容形式
    (0xFF00, 0xFFEF),  # 全角/半角形式
]


def in_keep_ranges(ch: str) -> bool:
    cp = ord(ch)
    for lo, hi in KEEP_RANGES:
        if lo <= cp <= hi:
            return True
    return False


def collect_ui_chars() -> set[str]:
    """扫 src/ 下所有源文件，收集界面里出现过的字符。"""
    chars: set[str] = set()
    exts = (".ts", ".tsx", ".js", ".jsx", ".html", ".css")
    for base, _dirs, files in os.walk(SRC_DIR):
        # 产物目录不参与
        if os.path.basename(base) in ("assets", "node_modules"):
            continue
        for name in files:
            if not name.endswith(exts):
                continue
            path = os.path.join(base, name)
            try:
                with io.open(path, "r", encoding="utf-8", errors="ignore") as fh:
                    text = fh.read()
            except OSError:
                continue
            for ch in text:
                if in_keep_ranges(ch):
                    chars.add(ch)
    return chars


def gb2312_level1() -> set[str]:
    """GB2312 一级字库（第 16–55 区，3755 个字）。"""
    chars: set[str] = set()
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return chars


def find_source(src_dir: str, *patterns: str) -> str | None:
    for pattern in patterns:
        hits = sorted(glob.glob(os.path.join(src_dir, pattern)))
        if hits:
            return hits[0]
    return None


def describe(path: str) -> str:
    try:
        return f"{os.path.basename(path)} ({os.path.getsize(path) // 1024} KB)"
    except OSError:
        return os.path.basename(path)


def make_subset(source: str, out_path: str, chars: set[str], wght: int | None) -> int:
    """子集化（必要时先实例化可变字体的某个字重），返回产物字节数。"""
    from fontTools import subset
    from fontTools.ttLib import TTFont

    font = TTFont(source)
    if wght is not None and "fvar" in font:
        from fontTools.varLib.instancer import instantiateVariableFont

        axes = {}
        for axis in font["fvar"].axes:
            tag = axis.axisTag
            if tag == "wght":
                axes[tag] = wght
            else:
                # 其余轴取默认值，得到确定的静态实例
                axes[tag] = axis.defaultValue
        font = instantiateVariableFont(font, axes, inplace=True, updateFontNames=False)

    text = "".join(sorted(chars))
    options = subset.Options()
    options.flavor = "woff"
    options.desubroutinize = True
    options.notdef_outline = True
    options.recalc_bounds = True
    options.drop_tables += ["DSIG"]
    # 保留名字表，否则字体名对不上 CSS 里的 family
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.name_languages = ["*"]
    options.layout_features = ["*"]

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=text)
    subsetter.subset(font)

    tmp = out_path + ".tmp"
    font.save(tmp)
    font.close()
    os.replace(tmp, out_path)
    return os.path.getsize(out_path)


PLAN = [
    {
        "out": "NotoSansSC-Regular.woff",
        "patterns": ("NotoSansSC*.ttf", "NotoSansSC*.otf", "NotoSansSC*.woff"),
        "charsets": ("ui", "gb2312-l1"),
        "wght": 400,
        "note": "常规字重，带 GB2312 一级字库，保证常规中文文案不掉字",
    },
    {
        "out": "NotoSansSC-Semibold.woff",
        "patterns": ("NotoSansSC*.ttf", "NotoSansSC*.otf", "NotoSansSC*.woff"),
        "charsets": ("ui",),
        "wght": 600,
        "note": "标题字重，只带界面用字",
    },
    {
        "out": "GoogleSans-400.woff",
        "patterns": ("GoogleSansFlex*.ttf", "GoogleSans*Flex*.ttf", "GoogleSans*.ttf"),
        "charsets": ("ui",),
        "wght": 400,
        "note": "正文拉丁",
    },
    {
        "out": "GoogleSans-500.woff",
        "patterns": ("GoogleSansFlex*.ttf", "GoogleSans*Flex*.ttf", "GoogleSans*.ttf"),
        "charsets": ("ui",),
        "wght": 500,
        "note": "中等字重",
    },
    {
        "out": "GoogleSans-600.woff",
        "patterns": ("GoogleSansFlex*.ttf", "GoogleSans*Flex*.ttf", "GoogleSans*.ttf"),
        "charsets": ("ui",),
        "wght": 600,
        "note": "标题拉丁",
    },
]


def report() -> int:
    print("当前产物：")
    total = 0
    missing = 0
    for item in PLAN:
        path = os.path.join(OUT_DIR, item["out"])
        if os.path.exists(path):
            size = os.path.getsize(path)
            total += size
            print(f"  [ok] {item['out']:<26} {size / 1024:8.1f} KB  {item['note']}")
        else:
            missing += 1
            print(f"  [!!] {item['out']:<26} {'缺失':>10}  {item['note']}")
    print(f"  合计 {total / 1024:.1f} KB" + (f"，缺 {missing} 个" if missing else ""))
    return 1 if missing else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="生成界面字体子集")
    parser.add_argument("--src", default=os.path.join(HERE, "fonts-src"), help="源字体目录")
    parser.add_argument("--check", action="store_true", help="只报告产物，不重新生成")
    parser.add_argument("--dry-run", action="store_true", help="只算字符集，不写文件")
    args = parser.parse_args()

    if args.check:
        return report()

    try:
        import fontTools  # noqa: F401
    except ImportError:
        print("[!!] 缺少 fontTools。先装：pip install fonttools")
        return 2

    ui = collect_ui_chars()
    l1 = gb2312_level1()
    charsets = {"ui": ui, "gb2312-l1": l1 | ui}
    print(f"字符集：ui {len(ui)} 字，gb2312-l1 {len(l1)} 字")
    if not ui:
        print("[!!] 没有扫到界面字符 —— src/ 是不是空的？")
        return 2

    os.makedirs(OUT_DIR, exist_ok=True)
    failures = 0
    produced: list[tuple[str, int]] = []

    for item in PLAN:
        source = find_source(args.src, *item["patterns"])
        out_path = os.path.join(OUT_DIR, item["out"])
        if not source:
            # 源字体不在时，只要产物已经存在就不算失败 —— 子集是检入仓库的。
            state = "产物已在" if os.path.exists(out_path) else "产物也缺"
            print(f"  [--] {item['out']:<26} 找不到源字体（{state}）")
            if not os.path.exists(out_path):
                failures += 1
            continue

        chars: set[str] = set()
        for name in item["charsets"]:
            chars |= charsets[name]

        if args.dry_run:
            print(f"  [--] {item['out']:<26} 将裁到 {len(chars)} 字（源 {describe(source)}）")
            continue

        try:
            size = make_subset(source, out_path, chars, item["wght"])
        except Exception as exc:  # noqa: BLE001 - 工具脚本，报错就要看得见
            print(f"  [!!] {item['out']:<26} 生成失败：{exc}")
            failures += 1
            continue
        produced.append((item["out"], size))
        print(
            f"  [ok] {item['out']:<26} {size / 1024:8.1f} KB  "
            f"（{len(chars)} 字，源 {describe(source)}，字重 {item['wght'] or '原样'}）"
        )

    if produced:
        print(f"新生成 {len(produced)} 个文件，合计 {sum(s for _, s in produced) / 1024:.1f} KB")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())