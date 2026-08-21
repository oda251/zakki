/**
 * blob 列の読み出しをドライバ差で壊れないように正規化する（issue #134）。
 *
 * libSQL クライアントは blob の表現がトランスポートで違う:
 * - ローカルファイル（sqlite3 バックエンド）→ node の `Buffer`
 * - HTTP / WebSocket（hrana。リモート Turso・Workers）→ `ArrayBuffer`
 *   （hrana-client の `valueFromProto` が `value.slice().buffer` を返す）
 *
 * テストはローカルファイルで回るので、`Buffer` 前提のコードは**テストでだけ通り
 * 本番のリモート接続で壊れる**。実際 `buf.buffer` は ArrayBuffer に対しては
 * undefined になり、封筒の base64 化が黙って壊れる。読み出し側は必ずここを通す。
 */
export function toBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
}
