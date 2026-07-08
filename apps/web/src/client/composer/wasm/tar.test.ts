import { describe, expect, test } from "bun:test";
import { Directory, File } from "@bjorn3/browser_wasi_shim";
import { buildTree, parseTar } from "./tar.ts";

// 512B の tar ヘッダを作る（checksum は parseTar が検証しないので省略）。
function header(name: string, size: number, typeflag: number): Uint8Array {
  const block = new Uint8Array(512);
  for (let i = 0; i < name.length; i++) block[i] = name.charCodeAt(i);
  const octal = `${size.toString(8).padStart(11, "0")}\0`;
  for (let i = 0; i < octal.length; i++) block[124 + i] = octal.charCodeAt(i);
  block[156] = typeflag;
  return block;
}

function fileBlocks(path: string, data: Uint8Array, typeflag = 0x30): Uint8Array[] {
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return [header(path, data.length, typeflag), padded];
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0) + 1024; // 末尾に終端ブロック
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

describe("parseTar", () => {
  test("通常ファイルとディレクトリを取り出す", () => {
    const tar = concat([
      header("Dictionary/", 0, 0x35),
      ...fileBlocks("Dictionary/mm.binary", new Uint8Array([1, 2, 3])),
      ...fileBlocks("Dictionary/louds/charID.chid", new TextEncoder().encode("abc")),
    ]);
    const entries = parseTar(tar);
    const paths = entries.map((e) => e.path);
    expect(paths).toEqual(["Dictionary", "Dictionary/mm.binary", "Dictionary/louds/charID.chid"]);
    const chid = entries.find((e) => e.path === "Dictionary/louds/charID.chid");
    expect(chid?.data).not.toBeNull();
    expect(new TextDecoder().decode(chid?.data ?? new Uint8Array())).toBe("abc");
  });

  test("512の倍数でないファイルサイズを正しく境界処理する", () => {
    const data = new TextEncoder().encode("x".repeat(600)); // 2 ブロックにまたがる
    const tar = concat([
      ...fileBlocks("a.bin", data),
      ...fileBlocks("b.bin", new TextEncoder().encode("tail")),
    ]);
    const entries = parseTar(tar);
    expect(entries.map((e) => e.path)).toEqual(["a.bin", "b.bin"]);
    expect(entries[0]?.data?.length).toBe(600);
    expect(new TextDecoder().decode(entries[1]?.data ?? new Uint8Array())).toBe("tail");
  });

  test("pax 拡張ヘッダ(x/g)や symlink は junk として mount しない", () => {
    const tar = concat([
      ...fileBlocks("pax_global_header", new TextEncoder().encode("52 path=whatever\n"), 0x67), // 'g'
      ...fileBlocks("Dictionary/real.bin", new Uint8Array([9])),
      header("Dictionary/link", 0, 0x32), // '2' symlink
    ]);
    const entries = parseTar(tar);
    expect(entries.map((e) => e.path)).toEqual(["Dictionary/real.bin"]);
  });
});

describe("buildTree", () => {
  test("ネストしたディレクトリ/ファイルを Directory ツリーに組む", () => {
    const entries = parseTar(
      concat([
        ...fileBlocks("Dictionary/mm.binary", new Uint8Array([1])),
        ...fileBlocks("Dictionary/louds/x.louds", new Uint8Array([2, 3])),
      ]),
    );
    const root = buildTree(entries);
    const dict = root.get("Dictionary");
    expect(dict).toBeInstanceOf(Directory);
    if (!(dict instanceof Directory)) throw new Error("Dictionary not a directory");
    expect(dict.contents.get("mm.binary")).toBeInstanceOf(File);
    const louds = dict.contents.get("louds");
    expect(louds).toBeInstanceOf(Directory);
    if (!(louds instanceof Directory)) throw new Error("louds not a directory");
    const x = louds.contents.get("x.louds");
    expect(x).toBeInstanceOf(File);
    if (!(x instanceof File)) throw new Error("x.louds not a file");
    expect(Array.from(x.data)).toEqual([2, 3]);
  });
});
