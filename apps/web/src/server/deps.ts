import type { Db } from "@zakki/data/db/client.ts";

/**
 * ルートが使う依存の束。index.ts（本番合成点）とテストが注入する。
 * サーバは暗号文の中継（replication / 封筒配布）のみで、DEK・復号・解析・変換
 * （かな漢字変換は #26 でクライアント wasm 実行へ移設）は持たない。
 */
export interface AppDeps {
  db: Db;
}
