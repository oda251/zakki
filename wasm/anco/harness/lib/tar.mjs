// 最小の tar(ustar/gnu) パーサ。辞書 tar を browser_wasi_shim の Directory ツリーに
// 展開するためだけの用途（regular file / directory / GNU longname のみ対応）。
import { File, Directory } from "../vendor/browser_wasi_shim.mjs";

export function parseTar(u8) {
  const out = [];
  let off = 0;
  let longName = null;
  const str = (start, len) => {
    let s = "";
    for (let i = start; i < start + len; i++) {
      if (u8[off + i] === 0) break;
      s += String.fromCharCode(u8[off + i]);
    }
    return s;
  };
  while (off + 512 <= u8.length) {
    let allZero = true;
    for (let i = 0; i < 512; i++) if (u8[off + i] !== 0) { allZero = false; break; }
    if (allZero) break;
    const name = str(0, 100);
    const size = parseInt(str(124, 12).trim(), 8) || 0;
    const typeflag = String.fromCharCode(u8[off + 156]);
    const prefix = str(345, 155);
    off += 512;
    if (typeflag === "L") {
      // GNU long name: 次エントリの本名がこのデータブロック
      longName = new TextDecoder().decode(u8.subarray(off, off + size)).replace(/\0+$/, "");
      off += Math.ceil(size / 512) * 512;
      continue;
    }
    const path = (longName ?? (prefix ? prefix + "/" + name : name)).replace(/\/+$/, "");
    longName = null;
    const isDir = typeflag === "5";
    const data = isDir ? null : u8.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (path) out.push({ path, isDir, data });
  }
  return out;
}

// tar エントリ列から browser_wasi_shim の Directory ツリー(Map)を組む。
export function buildTree(entries) {
  const root = new Map();
  const ensureDir = (parts) => {
    let cur = root;
    for (const p of parts) {
      let node = cur.get(p);
      if (!node) { node = new Directory(new Map()); cur.set(p, node); }
      cur = node.contents;
    }
    return cur;
  };
  for (const e of entries) {
    const parts = e.path.split("/");
    const base = parts.pop();
    const dir = ensureDir(parts);
    if (e.isDir) {
      if (!dir.get(base)) dir.set(base, new Directory(new Map()));
    } else {
      dir.set(base, new File(e.data, { readonly: true }));
    }
  }
  return root;
}
