import type { ChunkPresentation } from "@zakki/core/chunk/presentation.ts";

/**
 * Chunk.web（docs/COMPOSER.md）: 値は CSS 意味クラス名。ユーティリティは
 * styles.css 側に @apply で寄せる。Composer.Web（Phase 5）も同じクラスを共有する。
 */
export const chunkWeb: ChunkPresentation<string> = {
  base: "chunk",
  selected: "chunk--selected",
  pending: "chunk--pending",
};

/** 関連リスト項目（Digest）のクラス。ChunkPresentation の外側の web 固有補助 */
export const chunkDigestWeb = {
  base: "chunk-digest",
  date: "chunk-digest__date",
} as const;
