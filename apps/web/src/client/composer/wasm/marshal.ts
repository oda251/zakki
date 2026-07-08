/**
 * anco reactor wasm の C ABI（@_cdecl/@_expose）を JS から呼ぶブリッジ。issue #26。
 * 文字列は UTF-8 バイト列でやり取りし、zakki_alloc/zakki_free で wasm メモリを確保・解放する。
 * zakki_anco_convert の戻り値 i64 は (ptr<<32)|len。上位 32bit=結果ポインタ、下位=長さ。
 */
export interface AncoExports {
  readonly memory: WebAssembly.Memory;
  readonly zakki_alloc: (size: number) => number;
  readonly zakki_free: (ptr: number) => void;
  readonly zakki_anco_init: (ptr: number, len: number) => number;
  readonly zakki_anco_convert: (kp: number, kl: number, cp: number, cl: number) => bigint;
}

function hasAncoExports(ex: WebAssembly.Exports): ex is WebAssembly.Exports & AncoExports {
  return (
    ex.memory instanceof WebAssembly.Memory &&
    typeof ex.zakki_alloc === "function" &&
    typeof ex.zakki_free === "function" &&
    typeof ex.zakki_anco_init === "function" &&
    typeof ex.zakki_anco_convert === "function"
  );
}

/** インスタンスの exports が anco C ABI を備えていれば型付きで返す。無ければ null。 */
export function readAncoExports(instance: WebAssembly.Instance): AncoExports | null {
  return hasAncoExports(instance.exports) ? instance.exports : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}

export interface AncoCalls {
  /** 辞書ディレクトリ（ゲスト絶対パス）で初期化。true=成功（内部で readiness probe が走る）。 */
  readonly init: (dictPath: string) => boolean;
  /** かな + 左文脈 → 候補配列（良い順、先頭が最良）。 */
  readonly convert: (kana: string, leftContext: string) => string[];
}

export function bindEngine(ex: AncoExports): AncoCalls {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // メモリは alloc で grow するたび buffer が差し替わるので毎回取り直す。
  const mem = (): Uint8Array => new Uint8Array(ex.memory.buffer);
  const writeStr = (s: string): { ptr: number; len: number } => {
    const bytes = encoder.encode(s);
    const ptr = ex.zakki_alloc(bytes.length);
    mem().set(bytes, ptr);
    return { ptr, len: bytes.length };
  };
  const init = (dictPath: string): boolean => {
    const p = writeStr(dictPath);
    const rc = ex.zakki_anco_init(p.ptr, p.len);
    ex.zakki_free(p.ptr);
    return rc === 0;
  };
  const convert = (kana: string, leftContext: string): string[] => {
    const k = writeStr(kana);
    const c = writeStr(leftContext);
    const packed = ex.zakki_anco_convert(k.ptr, k.len, c.ptr, c.len);
    ex.zakki_free(k.ptr);
    ex.zakki_free(c.ptr);
    const ptr = Number(BigInt.asUintN(32, packed >> 32n));
    const len = Number(packed & 0xffffffffn);
    const bytes = mem().slice(ptr, ptr + len);
    ex.zakki_free(ptr);
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    return toStringArray(parsed);
  };
  return { init, convert };
}
