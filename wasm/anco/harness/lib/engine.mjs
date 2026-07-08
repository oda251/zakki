// anco reactor wasm の C ABI を JS から呼ぶための薄いブリッジ（issue #26）。
// Phase 3 で TS の KanaKanjiEngine 実装に置き換える際の参照実装でもある。
import { WASI, File, OpenFile, PreopenDirectory } from "../vendor/browser_wasi_shim.mjs";

// stdio(3) + 辞書 preopen の fds を組む。dictTree は tar.buildTree() の Map。
export function makeFds(dictTree, mountName = "/dict") {
  return [
    new OpenFile(new File([])), // stdin
    new OpenFile(new File([])), // stdout
    new OpenFile(new File([])), // stderr
    new PreopenDirectory(mountName, dictTree),
  ];
}

// reactor をインスタンス化し _initialize を呼ぶ（_start は呼ばない）。
export async function instantiateReactor(wasmModule, fds) {
  const wasi = new WASI([], [], fds, { debug: false });
  const instance = await WebAssembly.instantiate(wasmModule, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  wasi.initialize(instance);
  return { instance, wasi };
}

// C ABI（zakki_alloc/free/anco_init/anco_convert）をラップした呼び出し口を返す。
export function bindEngine(instance) {
  const ex = instance.exports;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  // memory は alloc で grow するたび buffer が差し替わるので毎回取り直す。
  const mem = () => new Uint8Array(ex.memory.buffer);
  const writeStr = (s) => {
    const bytes = enc.encode(s);
    const ptr = ex.zakki_alloc(bytes.length);
    mem().set(bytes, ptr);
    return [ptr, bytes.length];
  };
  // 辞書ディレクトリ（ゲスト絶対パス）で初期化。true=成功（内部で readiness probe）。
  const init = (dictPath) => {
    const [p, l] = writeStr(dictPath);
    const rc = ex.zakki_anco_init(p, l);
    ex.zakki_free(p);
    return rc === 0;
  };
  // かな + 左文脈 → 候補配列（良い順）。
  const convert = (kana, ctx = "") => {
    const [kp, kl] = writeStr(kana);
    const [cp, cl] = writeStr(ctx);
    const packed = ex.zakki_anco_convert(kp, kl, cp, cl); // i64 (BigInt)
    ex.zakki_free(kp);
    ex.zakki_free(cp);
    // 上位 32bit=ポインタ, 下位 32bit=長さ。unsigned として取り出す。
    const ptr = Number(BigInt.asUintN(32, packed >> 32n));
    const len = Number(packed & 0xffffffffn);
    const bytes = mem().slice(ptr, ptr + len);
    ex.zakki_free(ptr);
    return JSON.parse(dec.decode(bytes));
  };
  return { init, convert };
}
