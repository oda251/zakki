import type { ControlDb } from "@zakki/api/db/client.ts";

/**
 * ルートが使う依存の束（apps/web/src/server/deps.ts と同じ流儀）。
 * index.ts（Workers の本番合成点）とテストが注入する。
 * コントロールプレーンは E2E を破らない: DEK・本文・暗号鍵は扱わない。
 */
export interface AppDeps {
  db: ControlDb;
}
