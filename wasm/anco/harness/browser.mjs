// ブラウザで anco reactor を動かし初期化時間を実測するデバッグページ（issue #26）。
// 実ブラウザの streaming compile 経路で計測する。reactor.wasm と dict.tar は
// 同一オリジンに配置する（README 参照）。結果は window.__ANCO_RESULT__ にも出す。
import { parseTar, buildTree } from "./lib/tar.mjs";
import { makeFds, instantiateReactor, bindEngine } from "./lib/engine.mjs";

const log = (m) => { document.getElementById("log").textContent += m + "\n"; };
const setResult = (o) => {
  document.getElementById("result").textContent = JSON.stringify(o, null, 2);
  window.__ANCO_RESULT__ = o;
};

async function main() {
  const marks = {};
  const mark = (k) => { marks[k] = performance.now(); };
  const dur = (a, b) => +(marks[b] - marks[a]).toFixed(1);

  mark("t0");
  let wasmModule;
  try {
    wasmModule = await WebAssembly.compileStreaming(fetch("anco.reactor.wasm"));
  } catch (e) {
    log("compileStreaming fallback: " + e);
    wasmModule = await WebAssembly.compile(await (await fetch("anco.reactor.wasm")).arrayBuffer());
  }
  mark("compiled");

  const tarBuf = await (await fetch("dict.tar")).arrayBuffer();
  mark("fetched_dict");
  const dictTree = buildTree(parseTar(new Uint8Array(tarBuf)));
  mark("fs_built");

  const { instance } = await instantiateReactor(wasmModule, makeFds(dictTree));
  mark("initialized");
  const engine = bindEngine(instance);

  if (!engine.init("/dict/Dictionary")) { setResult({ error: "init failed" }); return; }
  mark("inited");

  mark("c1s");
  const first = engine.convert("にほんごにゅうりょく");
  mark("c1e");

  log("DONE");
  setResult({
    firstCandidates: first.slice(0, 5),
    timings_ms: {
      compile_wasm: dur("t0", "compiled"),
      fetch_dict: dur("compiled", "fetched_dict"),
      fs_build_from_tar: dur("fetched_dict", "fs_built"),
      instantiate_and_initialize: dur("fs_built", "initialized"),
      zakki_anco_init_with_probe: dur("initialized", "inited"),
      first_convert_cold: dur("c1s", "c1e"),
      total_compile_to_first_result: dur("t0", "c1e"),
    },
  });
}

main().catch((e) => setResult({ fatal: String(e?.stack || e) }));
