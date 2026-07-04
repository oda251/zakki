import { createRuriEmbedder } from "@zakki/backend/embedding/embedder.ts";

// Docker build 時に embedding モデル（約37MB）をイメージへ焼き込む。
// 初回リクエストのダウンロード待ちを避ける（apps/web/Dockerfile の WARMUP_EMBEDDER）。
const embedder = createRuriEmbedder();
const [vector] = await embedder.embed(["ウォームアップ"]);
if (vector === undefined || vector.length === 0) {
  throw new Error("embedder warmup failed");
}
console.log(`embedder warmup ok (model=${embedder.name}, dim=${vector.length})`);
