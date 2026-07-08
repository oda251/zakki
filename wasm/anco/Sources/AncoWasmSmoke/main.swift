// wasm32-unknown-wasi の実変換スモーク（issue #26 Phase 1）。
//
// 明示パスで辞書を読み込み（辞書ロード）、実変換（Viterbi）を 1 本流して候補を
// JSON で出力する。これで「モジュールが wasm にリンクできる」だけでなく
// 「WASI ランタイム上で辞書を読み、変換が最後まで走る」ことまで CI で確かめる。
// wasmtime では `--dir=<host>::<guest>` で辞書ディレクトリを mount する前提。
//
// 使い方: AncoWasmSmoke <dictDir> <kana> [leftContext]
// 出力は grep しやすいよう固定プレフィックス付き（CI が候補と所要時間を検証する）。
import Foundation
import AncoWasmBridge

let args = CommandLine.arguments
let dictDir = args.count > 1 ? args[1] : "/dict/Dictionary"
let kana = args.count > 2 ? args[2] : "にほんごにゅうりょく"
let leftContext: String? = args.count > 3 ? args[3] : nil

func stderr(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

func millisSince(_ start: Date) -> Double {
    Date().timeIntervalSince(start) * 1000
}

let initStart = Date()
guard ancoInitialize(dictPath: dictDir) else {
    stderr("ANCO_SMOKE: init failed for dictDir=\(dictDir)")
    exit(2)
}
print(String(format: "ANCO_SMOKE_INIT_MS %.1f", millisSince(initStart)))

let convertStart = Date()
let candidates = ancoConvert(kana: kana, leftContext: leftContext)
print(String(format: "ANCO_SMOKE_CONVERT_MS %.1f", millisSince(convertStart)))

let json = (try? String(decoding: JSONEncoder().encode(candidates), as: UTF8.self)) ?? "[]"
print("ANCO_SMOKE_INPUT \(kana)")
print("ANCO_SMOKE_CANDIDATES \(json)")

guard let best = candidates.first, !best.isEmpty else {
    stderr("ANCO_SMOKE: no candidate produced (dictionary load or conversion failed)")
    exit(1)
}
print("ANCO_SMOKE_BEST \(best)")
