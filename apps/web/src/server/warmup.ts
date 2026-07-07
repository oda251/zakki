import { createRuriEmbedder, EMBEDDING_DIMS } from "@zakki/backend/embedding/embedder.ts";

// Docker build 時に embedding モデル（約37MB）をイメージへ焼き込む。
// 初回リクエストのダウンロード待ちを避ける（apps/web/Dockerfile の WARMUP_EMBEDDER）。
// ついでにモデル契約（出力次元 = EMBEDDING_DIMS）をビルド時に検証する（issue #56）。
const embedder = createRuriEmbedder();
const [vector] = await embedder.embed(["ウォームアップ"]);
if (vector === undefined || vector.length !== EMBEDDING_DIMS) {
  throw new Error(`embedder warmup failed (dim=${vector?.length ?? "none"})`);
}
console.log(`embedder warmup ok (model=${embedder.name}, dim=${vector.length})`);
