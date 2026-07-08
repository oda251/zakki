// ブラウザ配布用 reactor モジュールのエントリ（issue #26 Phase 2）。
//
// reactor exec-model（-mexec-model=reactor）でビルドすると、エントリは _start では
// なく _initialize になる。JS は WASI shim の `initialize(instance)` で _initialize を
// 呼んで Swift ランタイム/グローバル初期化子を走らせた後、AncoWasmBridge の C ABI
// export（zakki_anco_init / zakki_anco_convert / zakki_alloc / zakki_free）を直接呼ぶ。
//
// トップレベルコードは reactor では実行されない。AncoWasmBridge を import して
// @_expose(wasm) された export をリンクに含めるためだけのファイル。
import AncoWasmBridge
