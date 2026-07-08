// anco reactor wasm の初期化・変換コストを node(V8) で実測する（issue #26 Phase 2）。
// V8 は Chrome と同じ wasm エンジンなので compile/変換の計算コストは代表値になる。
// 実ブラウザは streaming compile + ネットワーク取得で経路が異なる点は別途注記する。
//
// 使い方: node measure.mjs <reactor.wasm> <dict.tar>
import { readFileSync } from "node:fs";
import { parseTar, buildTree } from "./lib/tar.mjs";
import { makeFds, instantiateReactor, bindEngine } from "./lib/engine.mjs";

const [wasmPath, tarPath] = process.argv.slice(2);
if (!wasmPath || !tarPath) {
  console.error("usage: node measure.mjs <reactor.wasm> <dict.tar>");
  process.exit(2);
}

const wasmBytes = readFileSync(wasmPath);
const tarBytes = readFileSync(tarPath);

const marks = {};
const mark = (k) => { marks[k] = performance.now(); };
const dur = (a, b) => +(marks[b] - marks[a]).toFixed(1);

mark("t0");
const wasmModule = await WebAssembly.compile(wasmBytes);
mark("compiled");
const dictTree = buildTree(parseTar(new Uint8Array(tarBytes)));
mark("fs_built");
const { instance } = await instantiateReactor(wasmModule, makeFds(dictTree));
mark("initialized");
const engine = bindEngine(instance);

if (!engine.init("/dict/Dictionary")) {
  console.error("zakki_anco_init failed (dictionary not readable)");
  process.exit(1);
}
mark("inited");

mark("c1s");
const first = engine.convert("にほんごにゅうりょく");
mark("c1e");
const warm = ["きょうは", "てんきがいい", "にほんご", "へんかん", "あさごはん"];
const ws = performance.now();
for (const w of warm) engine.convert(w);
const warmAvg = +((performance.now() - ws) / warm.length).toFixed(2);

console.log(JSON.stringify({
  runtime: `node ${process.version} (V8, = Chrome の wasm エンジン)`,
  firstCandidates: first.slice(0, 5),
  wasm_bytes: wasmBytes.length,
  dict_tar_bytes: tarBytes.length,
  timings_ms: {
    compile_wasm: dur("t0", "compiled"),
    fs_build_from_tar: dur("compiled", "fs_built"),
    instantiate_and_initialize: dur("fs_built", "initialized"),
    zakki_anco_init_with_probe: dur("initialized", "inited"),
    first_convert_cold: dur("c1s", "c1e"),
    warm_convert_avg: warmAvg,
    total_compile_to_first_result: dur("t0", "c1e"),
  },
}, null, 2));
