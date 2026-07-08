// zakki の wasm かな漢字変換ブリッジ（issue #26）。
//
// 辞書は Bundle.module を使わず、明示パス `DicdataStore(dictionaryURL:)` で読む。
// これにより WithDefaultDictionary の resource_bundle_accessor を経由せず、
// ブラウザ側で仮想 FS の固定パスに辞書を mount して読ませられる（上流追従性が高い）。
//
// ブラウザからは下の C ABI（@_cdecl）を呼ぶ。文字列は UTF-8 バイト列で受け渡しし、
// wasm リニアメモリ上のバッファを zakki_alloc / zakki_free で確保・解放する。
// 変換結果は候補文字列の JSON 配列（UTF-8）で返す。
//
// wasm はシングルスレッドのため、変換器はグローバルに 1 つだけ保持する
// （辞書ロードは重いので init 1 回・convert 多数）。
import Foundation
import KanaKanjiConverterModule

nonisolated(unsafe) private var sharedConverter: KanaKanjiConverter?

private func decodeUTF8(_ ptr: UnsafePointer<UInt8>?, _ len: Int32) -> String {
    guard let ptr, len > 0 else { return "" }
    return String(decoding: UnsafeBufferPointer(start: ptr, count: Int(len)), as: UTF8.self)
}

/// 戻り値 (ptr << 32 | len) を組み立てる。JS 側は memory[ptr..<ptr+len] を読み、
/// zakki_free(ptr) で解放する。ptr は wasm32 の 32bit アドレス。
private func packBytes(_ bytes: [UInt8]) -> Int64 {
    let count = bytes.count
    let raw = UnsafeMutableRawPointer.allocate(byteCount: max(count, 1), alignment: 1)
    if count > 0 {
        bytes.withUnsafeBytes { raw.copyMemory(from: $0.baseAddress!, byteCount: count) }
    }
    let addr = UInt(bitPattern: raw)
    return (Int64(addr) << 32) | Int64(count)
}

// MARK: - Swift API（スモークからも呼ぶ実体）

/// 辞書ディレクトリを明示パスで受け取り変換器を初期化する。成功で true。
///
/// DicdataStore は遅延ロードで、コンストラクタは辞書ファイルを読まない
/// （欠損してもここでは失敗しない）。そこで既知の語を 1 回変換する probe を行い、
/// 辞書が実際に読めている（候補が出る）ことを確認してから true を返す。
/// 辞書欠損・mount ミスを初期化失敗として扱う（issue #26: フォールバックなし・
/// 初期化失敗はブロッキングエラー）。probe は init 時 1 回のみで安価。
public func ancoInitialize(dictPath: String) -> Bool {
    guard !dictPath.isEmpty else { return false }
    let store = DicdataStore(dictionaryURL: URL(fileURLWithPath: dictPath))
    sharedConverter = KanaKanjiConverter(dicdataStore: store)
    if ancoConvert(kana: "にほんご", leftContext: nil).isEmpty {
        sharedConverter = nil
        return false
    }
    return true
}

/// かな文＋左文脈を変換し、候補を良い順（先頭が最良）で返す。
/// 予測変換・学習・zenz は無効（純粋な変換のみ。zakki の anco session と同条件）。
public func ancoConvert(kana: String, leftContext: String?) -> [String] {
    guard let converter = sharedConverter, !kana.isEmpty else { return [] }
    var composing = ComposingText()
    composing.insertAtCursorPosition(kana, inputStyle: .direct)
    let options = ConvertRequestOptions(
        N_best: 10,
        requireJapanesePrediction: false,
        requireEnglishPrediction: false,
        keyboardLanguage: .ja_JP,
        englishCandidateInRoman2KanaInput: true,
        fullWidthRomanCandidate: false,
        halfWidthKanaCandidate: false,
        learningType: .nothing,
        maxMemoryCount: 0,
        shouldResetMemory: false,
        memoryDirectoryURL: URL(fileURLWithPath: ""),
        sharedContainerURL: URL(fileURLWithPath: ""),
        textReplacer: .empty,
        specialCandidateProviders: nil,
        zenzaiMode: .off,
        metadata: .init(versionString: "zakki-anco-wasm")
    )
    return converter.requestCandidates(composing, options: options).mainResults.map(\.text)
}

// MARK: - C ABI（ブラウザから呼ぶ export）
//
// reactor モジュールでは @_expose(wasm, "name") で export され、明示 --export は不要。
// @_cdecl は C ABI で呼ぶために引き続き必要（book.swiftwasm.org/examples/exporting-function）。

/// JS が入力バイト列を書き込むためのバッファを wasm メモリに確保する。
@_expose(wasm, "zakki_alloc")
@_cdecl("zakki_alloc")
public func zakki_alloc(_ size: Int32) -> UnsafeMutableRawPointer? {
    guard size > 0 else { return nil }
    return UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 1)
}

/// zakki_alloc / zakki_anco_convert が返したバッファを解放する。
@_expose(wasm, "zakki_free")
@_cdecl("zakki_free")
public func zakki_free(_ ptr: UnsafeMutableRawPointer?) {
    ptr?.deallocate()
}

/// 辞書ディレクトリの絶対パス（UTF-8）を受け取り初期化する。0 = 成功、非 0 = 失敗。
@_expose(wasm, "zakki_anco_init")
@_cdecl("zakki_anco_init")
public func zakki_anco_init(_ pathPtr: UnsafePointer<UInt8>?, _ pathLen: Int32) -> Int32 {
    ancoInitialize(dictPath: decodeUTF8(pathPtr, pathLen)) ? 0 : 1
}

/// かな＋左文脈を変換し、候補の JSON 配列（UTF-8）を (ptr << 32 | len) で返す。
@_expose(wasm, "zakki_anco_convert")
@_cdecl("zakki_anco_convert")
public func zakki_anco_convert(
    _ kanaPtr: UnsafePointer<UInt8>?, _ kanaLen: Int32,
    _ ctxPtr: UnsafePointer<UInt8>?, _ ctxLen: Int32
) -> Int64 {
    let ctx = decodeUTF8(ctxPtr, ctxLen)
    let candidates = ancoConvert(kana: decodeUTF8(kanaPtr, kanaLen), leftContext: ctx.isEmpty ? nil : ctx)
    let json = (try? JSONEncoder().encode(candidates)) ?? Data("[]".utf8)
    return packBytes([UInt8](json))
}
