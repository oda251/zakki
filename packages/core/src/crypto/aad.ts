/**
 * AEAD の AAD（追加認証データ）に使うフィールドラベルの単一定義（#47）。
 *
 * ラベルは暗号文に焼き込まれており、値を変えると既存の暗号化済みデータが
 * AAD 不一致で復号できなくなる（黙って throw する）。**値の変更は不可**。
 * リネームはキー名（左辺）のみ許される。
 *
 * 旧テーブル由来のレガシーラベル（"session.name" / "sessionTag.name"）は
 * AAD 付替え（`@zakki/data/crypto/init.ts` の applyAadFixups）でのみ使う
 * 過渡的な値のため、ここには含めない。
 */
export const AAD = {
  chunkContent: "chunk.content",
  tagName: "tag.name",
  chunkUserTagName: "chunkUserTag.name",
  embeddingVector: "embedding.vector",
} as const;
