#!/usr/bin/env python3
"""wasm モジュールの export セクションを解析し、export 名を 1 行ずつ出力する。

CI での C ABI export 検証に使う。wasm-objdump 等のテキスト整形に依存すると
出力フォーマット差でグレップが誤検知するため、export セクション（section id 7）を
直接読む。ブラウザ側 JS グルーが依存する export 名の突き合わせにも使える。
"""

from __future__ import annotations

import sys
from pathlib import Path


def _leb128(data: bytes, offset: int) -> tuple[int, int]:
    """符号なし LEB128 を読み、(値, 次オフセット) を返す。"""
    result = shift = 0
    while True:
        byte = data[offset]
        offset += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, offset
        shift += 7


def export_names(data: bytes) -> list[str]:
    if data[:4] != b"\x00asm":
        raise ValueError("not a wasm module (bad magic)")
    offset = 8  # magic(4) + version(4)
    while offset < len(data):
        section_id = data[offset]
        offset += 1
        size, offset = _leb128(data, offset)
        section_end = offset + size
        if section_id == 7:  # export section
            count, offset = _leb128(data, offset)
            names: list[str] = []
            for _ in range(count):
                name_len, offset = _leb128(data, offset)
                names.append(data[offset : offset + name_len].decode("utf-8"))
                offset += name_len
                offset += 1  # export kind
                _, offset = _leb128(data, offset)  # export index
            return names
        offset = section_end
    return []


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: list-wasm-exports.py <module.wasm>", file=sys.stderr)
        return 2
    for name in export_names(Path(sys.argv[1]).read_bytes()):
        print(name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
