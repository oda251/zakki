import type { Embedder } from "@zakki/core/embedding/types.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { addSemanticLinks } from "@zakki/data/embedding/semantic.ts";
import { loadVectors, syncChunkEmbeddings } from "@zakki/data/embedding/store.ts";
import { analyzeAll } from "./service.ts";

/**
 * 解析パイプライン 1 回分: 解析（タグ・キーワード関連・極性）→ 埋め込み同期 →
 * セマンティック関連付け。TUI の runBackgroundPass と web サーバの解析スケジューラが共有する。
 *
 * エラーは onError に流して継続する（部分失敗しても他の段は進める）。
 * @returns 同期済みの埋め込みベクトル（呼び出し側の関連表示に再利用できる）。embedder 無し・失敗時は null
 */
export async function runAnalysisPass(
  db: Db,
  embedder: Embedder | null,
  onError: (message: string) => void,
): Promise<ReadonlyMap<number, Float32Array> | null> {
  await analyzeAll(db).match(
    () => {},
    (e) => onError(`解析: ${e.message}`),
  );
  if (embedder === null) return null;
  const synced = await syncChunkEmbeddings(db, embedder);
  return await synced
    .asyncAndThen(() => loadVectors(db))
    .match(
      async (vectors) => {
        await addSemanticLinks(db, vectors).match(
          () => {},
          (e) => onError(`関連付け: ${e.message}`),
        );
        return vectors as ReadonlyMap<number, Float32Array>;
      },
      (e) => {
        onError(`埋め込み: ${e.message}`);
        return null;
      },
    );
}
