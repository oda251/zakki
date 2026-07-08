#!/usr/bin/env python3
"""AzooKeyKanaKanjiConverter の Package.swift を wasm32-unknown-wasi ビルド用に加工する。

方針は上流 PR #241（azooKey/AzooKeyKanaKanjiConverter#241「Enable WASI build by
skipping CLI」）に準拠。WASI SDK でビルドできない CliTool（swift-argument-parser
依存の実行ファイル）と、ホスト Linux 判定の objc リンカブロックを manifest から外し、
代わりに zakki 側の wasm ブリッジ／スモークターゲットを注入する。

辞書は Bundle.module ではなく明示パス（DicdataStore(dictionaryURL:)）で読むため、
ブリッジは plain な KanaKanjiConverterModule にのみ依存する（KanaKanjiConverter-
ModuleWithDefaultDictionary もそのテストもビルド対象にしない）。zenz/llama.cpp/
SwiftyMarisa は Zenzai trait off で非リンク。

CI が checkout した使い捨てクローンに対してのみ適用する破壊的加工。アンカーが
見つからなければ（＝上流ドリフト）異常終了し、CI で気付けるようにする。冪等ではない。
"""

from __future__ import annotations

import sys
from pathlib import Path

ARG_PARSER_DEP = (
    '    .package(url: "https://github.com/apple/swift-argument-parser", '
    '.upToNextMajor(from: "1.0.0")),\n'
)
CLI_TARGET_ANCHOR = '    .executableTarget(\n        name: "CliTool",'
# ホスト Linux 時のみ動く objc リンカ判定ブロック。CliTool 撤去で本来の対象を失い、
# かつ -lobjc は wasm リンクで無効なので丸ごと外す。
OBJC_BLOCK_START = "#if os(Linux) && !canImport(Android)\nfunc checkObjcAvailability"
PACKAGE_ANCHOR = "\nlet package = Package("
# zakki の wasm ブリッジ（C ABI）とスモーク実行ファイルを package 宣言の直前に注入する。
# ソースは呼び出し側が Sources/AncoWasmBridge/ と Sources/AncoWasmSmoke/ に配置する前提。
INJECT_TARGETS = (
    "\n// --- injected by zakki wasm/anco/patch/anco-wasi-gate.py ---\n"
    "targets.append(\n"
    "    .target(\n"
    '        name: "AncoWasmBridge",\n'
    '        dependencies: ["KanaKanjiConverterModule"],\n'
    "        swiftSettings: swiftSettings\n"
    "    )\n"
    ")\n"
    "targets.append(\n"
    "    .executableTarget(\n"
    '        name: "AncoWasmSmoke",\n'
    '        dependencies: ["AncoWasmBridge"],\n'
    "        swiftSettings: swiftSettings\n"
    "    )\n"
    ")\n"
)


def _remove_balanced_block(text: str, anchor: str) -> str:
    """anchor で始まる `.executableTarget( ... )` を、直後の "," 込みで削除する。"""
    start = text.index(anchor)
    # anchor 内の "(" から括弧の対応を取って閉じ位置を探す
    open_paren = text.index("(", start)
    depth = 0
    i = open_paren
    while i < len(text):
        ch = text[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                break
        i += 1
    else:
        raise ValueError("unbalanced parentheses for CliTool target")
    end = i + 1
    # 直後の "," と続く空白/改行を巻き取り、配列要素として綺麗に消す
    j = end
    while j < len(text) and text[j] in ", ":
        j += 1
    if text[j : j + 1] == "\n":
        j += 1
    # 行頭のインデントも消す
    line_start = text.rfind("\n", 0, start) + 1
    return text[:line_start] + text[j:]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: anco-wasi-gate.py <path-to-Package.swift>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    text = path.read_text()

    if ARG_PARSER_DEP not in text:
        print("anchor not found: swift-argument-parser dependency line", file=sys.stderr)
        return 1
    if CLI_TARGET_ANCHOR not in text:
        print("anchor not found: CliTool executableTarget", file=sys.stderr)
        return 1
    if OBJC_BLOCK_START not in text:
        print("anchor not found: objc availability #if block", file=sys.stderr)
        return 1
    if PACKAGE_ANCHOR not in text:
        print("anchor not found: let package = Package(", file=sys.stderr)
        return 1

    text = text.replace(ARG_PARSER_DEP, "", 1)
    text = _remove_balanced_block(text, CLI_TARGET_ANCHOR)

    # objc 判定ブロックを #if ... 対応する #endif ごと削除する
    obj_start = text.index(OBJC_BLOCK_START)
    obj_endif = text.index("\n#endif", obj_start) + len("\n#endif")
    if text[obj_endif : obj_endif + 1] == "\n":
        obj_endif += 1
    text = text[:obj_start] + text[obj_endif:]

    if "AncoWasmBridge" not in text:
        text = text.replace(PACKAGE_ANCHOR, INJECT_TARGETS + PACKAGE_ANCHOR, 1)

    if "CliTool" in text or "swift-argument-parser" in text:
        print("residual reference to CliTool/argument-parser after gating", file=sys.stderr)
        return 1

    path.write_text(text)
    print(f"gated {path} for wasm32-unknown-wasi (removed CliTool + argument-parser, injected AncoWasm targets)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
