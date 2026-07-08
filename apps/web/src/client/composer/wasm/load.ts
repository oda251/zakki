import { File, OpenFile, PreopenDirectory, WASI } from "@bjorn3/browser_wasi_shim";
import { bindEngine, readAncoExports, type AncoCalls } from "./marshal.ts";
import { buildTree, parseTar } from "./tar.ts";

/**
 * ブラウザで anco reactor wasm をロードして変換ブリッジを返す。issue #26 Phase 3。
 *
 * アセットは同一オリジン配信（CSP: default-src 'self'）。サーバは .br を
 * Content-Encoding: br で返すので、fetch は解凍済みバイトを得る。Cache API で
 * 2 回目以降の DL（reactor ~13MB + 辞書 ~7MB, brotli）を省く。
 * 辞書は browser_wasi_shim の仮想 FS で /dict/Dictionary に mount する。
 */
export const ANCO_WASM_URL = "/anco/anco.reactor.wasm.br";
export const ANCO_DICT_URL = "/anco/dict.tar.br";
const CACHE_NAME = "zakki-anco-v1";
const GUEST_MOUNT = "/dict";
const GUEST_DICT_PATH = "/dict/Dictionary";

async function cachedFetch(url: string): Promise<Response> {
  if ("caches" in globalThis) {
    const cache = await globalThis.caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return hit;
    const res = await fetch(url);
    if (res.ok) await cache.put(url, res.clone());
    return res;
  }
  return fetch(url);
}

async function compile(res: Response): Promise<WebAssembly.Module> {
  // Content-Type が application/wasm なら streaming compile（DL とコンパイルを重ねる）。
  // そうでなければ arrayBuffer 経由にフォールバック。
  try {
    return await WebAssembly.compileStreaming(res.clone());
  } catch {
    return WebAssembly.compile(await res.arrayBuffer());
  }
}

/** ロード失敗（アセット取得・コンパイル・辞書読込のいずれか）。フォールバックはしない。 */
export class AncoLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AncoLoadError";
  }
}

// wasi.initialize は reactor の memory/_initialize export を要求する。
// WebAssembly.Instance の exports は index 型なので、型ガードで shape を確定する。
type ReactorInstance = WebAssembly.Instance & {
  readonly exports: { readonly memory: WebAssembly.Memory; readonly _initialize?: () => unknown };
};
function isReactorInstance(instance: WebAssembly.Instance): instance is ReactorInstance {
  return instance.exports.memory instanceof WebAssembly.Memory;
}

export async function loadAncoEngine(): Promise<AncoCalls> {
  const [wasmRes, dictRes] = await Promise.all([
    cachedFetch(ANCO_WASM_URL),
    cachedFetch(ANCO_DICT_URL),
  ]);
  if (!wasmRes.ok) throw new AncoLoadError(`wasm fetch failed: ${wasmRes.status}`);
  if (!dictRes.ok) throw new AncoLoadError(`dict fetch failed: ${dictRes.status}`);

  const wasmModule = await compile(wasmRes);
  const tree = buildTree(parseTar(new Uint8Array(await dictRes.arrayBuffer())));
  const fds = [
    new OpenFile(new File([])), // stdin
    new OpenFile(new File([])), // stdout
    new OpenFile(new File([])), // stderr
    new PreopenDirectory(GUEST_MOUNT, tree),
  ];
  const wasi = new WASI([], [], fds, { debug: false });
  const instance = await WebAssembly.instantiate(wasmModule, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  if (!isReactorInstance(instance)) throw new AncoLoadError("wasm memory export missing");
  wasi.initialize(instance);

  const exports = readAncoExports(instance);
  if (exports === null) throw new AncoLoadError("anco C ABI exports missing");
  const calls = bindEngine(exports);
  if (!calls.init(GUEST_DICT_PATH)) {
    throw new AncoLoadError("anco init failed: dictionary unreadable (readiness probe failed)");
  }
  return calls;
}
