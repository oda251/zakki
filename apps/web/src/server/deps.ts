import type { KanaKanjiEngine } from "@zakki/core/conversion/engine.ts";
import type { Db } from "@zakki/data/db/client.ts";

/**
 * ルートが使う依存の束。index.ts（本番合成点）とテストが注入する。
 * サーバは暗号文の中継（replication / 封筒配布）と変換エンジンのみで、
 * DEK・復号・解析（embedder / analysis）は持たない（#45。解析のクライアント
 * 移設は #28/#26）。
 */
export interface AppDeps {
  db: Db;
  engine: KanaKanjiEngine;
}
