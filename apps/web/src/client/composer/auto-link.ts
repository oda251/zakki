/**
 * 新規チャンクの自動リンク（数珠繋ぎ）の純粋ロジック。
 * 保存応答（position ベース upsert のため既存 id は安定）から新チャンクを検出し、
 * 「選択中の投稿」をアンカーに連鎖リンク列を作る。配線は Composer が行う。
 */

/** 保存応答のうち、直前の既知 id に無いチャンク id を保存順で返す */
export function newChunkIds(
  prevIds: readonly number[],
  saved: readonly { id: number }[],
): number[] {
  const known = new Set(prevIds);
  return saved.filter((c) => !known.has(c.id)).map((c) => c.id);
}

export interface LinkDraft {
  from: number;
  to: number;
}

/**
 * アンカー（選択中の投稿）→ 新1 → 新2 … の数珠繋ぎリンク列。
 * アンカーが無ければ先頭はリンクなし（新チャンク間のみ連鎖）。自己リンクは作らない。
 */
export function chainLinks(anchor: number | null, newIds: readonly number[]): LinkDraft[] {
  const links: LinkDraft[] = [];
  let prev = anchor;
  for (const id of newIds) {
    if (prev !== null && prev !== id) {
      links.push({ from: prev, to: id });
    }
    prev = id;
  }
  return links;
}
