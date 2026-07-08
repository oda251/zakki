import { describe, expect, test } from "bun:test";
import { type AncoExports, bindEngine } from "./marshal.ts";

// C ABI を模した最小の wasm 相当（bump アロケータ + JSON 応答）。marshalling
// （writeStr のメモリ書込・i64 パッキング・free 順序・JSON 復号）を検証する。
function fakeExports(): AncoExports {
  const memory = new WebAssembly.Memory({ initial: 4 });
  let next = 1024; // 0 は null 相当なので避ける
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const readStr = (ptr: number, len: number): string =>
    decoder.decode(new Uint8Array(memory.buffer).subarray(ptr, ptr + len));
  const alloc = (size: number): number => {
    const p = next;
    next += Math.ceil(Math.max(size, 1) / 8) * 8;
    return p;
  };
  return {
    memory,
    zakki_alloc: alloc,
    zakki_free: () => {},
    zakki_anco_init: (ptr, len) => (readStr(ptr, len).includes("Dictionary") ? 0 : 1),
    zakki_anco_convert: (kp, kl) => {
      const kana = readStr(kp, kl);
      const json = encoder.encode(JSON.stringify([`${kana}変換`, kana]));
      const p = alloc(json.length);
      new Uint8Array(memory.buffer).set(json, p);
      return (BigInt(p) << 32n) | BigInt(json.length);
    },
  };
}

describe("bindEngine", () => {
  test("init は辞書パスで成功/失敗を返す", () => {
    const calls = bindEngine(fakeExports());
    expect(calls.init("/dict/Dictionary")).toBe(true);
    expect(calls.init("/dict/wrong")).toBe(false);
  });

  test("convert はメモリ受け渡しを往復して候補配列を返す", () => {
    const calls = bindEngine(fakeExports());
    expect(calls.convert("にほんご", "")).toEqual(["にほんご変換", "にほんご"]);
  });

  test("左文脈も渡せる（マルチバイト長を正しく扱う）", () => {
    const calls = bindEngine(fakeExports());
    const result = calls.convert("あさ", "きょうは");
    expect(result[0]).toBe("あさ変換");
  });
});
