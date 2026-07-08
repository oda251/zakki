import { Directory, File, type Inode } from "@bjorn3/browser_wasi_shim";

/**
 * 最小の tar(ustar/gnu) パーサ。辞書 tar を browser_wasi_shim の仮想 FS に展開する
 * ためだけの用途（通常ファイル / ディレクトリ / GNU longname のみ対応。pax 拡張
 * ヘッダや symlink 等は辞書に不要なのでスキップする）。issue #26。
 */
export interface TarEntry {
  readonly path: string;
  readonly isDir: boolean;
  readonly data: Uint8Array | null;
}

const BLOCK = 512;
const NUL = String.fromCharCode(0);
const TYPE_FILE = 0x30; // '0'
const TYPE_FILE_NUL = 0x00; // 古い tar の通常ファイル
const TYPE_CONTIGUOUS = 0x37; // '7'
const TYPE_DIR = 0x35; // '5'
const TYPE_GNU_LONGNAME = 0x4c; // 'L'

function readString(u8: Uint8Array, start: number, len: number): string {
  let s = "";
  for (let i = start; i < start + len; i++) {
    const byte = u8[i];
    if (byte === undefined || byte === 0) break;
    s += String.fromCharCode(byte);
  }
  return s;
}

function stripTrailingNul(s: string): string {
  const nul = s.indexOf(NUL);
  return nul === -1 ? s : s.slice(0, nul);
}

export function parseTar(u8: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | null = null;
  while (off + BLOCK <= u8.length) {
    let allZero = true;
    for (let i = 0; i < BLOCK; i++) {
      if (u8[off + i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;
    const name = readString(u8, off, 100);
    const size = Number.parseInt(readString(u8, off + 124, 12).trim(), 8) || 0;
    const typeflag = u8[off + 156];
    const prefix = readString(u8, off + 345, 155);
    off += BLOCK;
    const dataLen = Math.ceil(size / BLOCK) * BLOCK;
    if (typeflag === TYPE_GNU_LONGNAME) {
      longName = stripTrailingNul(new TextDecoder().decode(u8.subarray(off, off + size)));
      off += dataLen;
      continue;
    }
    const isDir = typeflag === TYPE_DIR;
    const isFile =
      typeflag === TYPE_FILE || typeflag === TYPE_FILE_NUL || typeflag === TYPE_CONTIGUOUS;
    if (!isDir && !isFile) {
      // pax('x'/'g')・symlink 等は辞書 FS に不要なのでデータごとスキップ
      off += dataLen;
      longName = null;
      continue;
    }
    const rawPath = longName ?? (prefix ? `${prefix}/${name}` : name);
    const path = rawPath.replace(/\/+$/, "");
    longName = null;
    const data = isDir ? null : u8.subarray(off, off + size);
    off += dataLen;
    if (path) out.push({ path, isDir, data });
  }
  return out;
}

/** tar エントリ列から browser_wasi_shim の Directory ツリー(Map)を組む。 */
export function buildTree(entries: readonly TarEntry[]): Map<string, Inode> {
  const root = new Map<string, Inode>();
  const ensureDir = (parts: readonly string[]): Map<string, Inode> => {
    let cur = root;
    for (const part of parts) {
      const existing = cur.get(part);
      if (existing instanceof Directory) {
        cur = existing.contents;
      } else {
        const dir = new Directory(new Map<string, Inode>());
        cur.set(part, dir);
        cur = dir.contents;
      }
    }
    return cur;
  };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    const base = parts.pop();
    if (base === undefined) continue;
    const dir = ensureDir(parts);
    if (entry.isDir) {
      if (!(dir.get(base) instanceof Directory))
        dir.set(base, new Directory(new Map<string, Inode>()));
    } else {
      dir.set(base, new File(entry.data ?? new Uint8Array(0), { readonly: true }));
    }
  }
  return root;
}
