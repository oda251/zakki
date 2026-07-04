import type { KanaKanjiEngine } from "@zakki/core/conversion/engine.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { AnalysisScheduler } from "./analysis.ts";

/** ルートが使う依存の束。index.ts（本番合成点）とテストが注入する */
export interface AppDeps {
  db: Db;
  engine: KanaKanjiEngine;
  embedder: Embedder | null;
  analysis: AnalysisScheduler;
}
