/**
 * 親バッファ保存時の草稿 ⇄ 既存行の突き合わせ（docs/CHUNKS.md §入力・保存）。
 *
 * サーバ（`@zakki/data` repository.saveChildren）とクライアント
 * （web client writes.saveChildrenDocs, #44）が「どの既存 id を保つか」という
 * 最重要不変条件を共有するための純関数カーネル。二重実装だと投影が実装間で
 * 割れ、同じバッファから異なる子チャンク集合が生まれる。
 *
 * 1. content 完全一致（同文が複数あれば position 順に消費）
 * 2. 未対応の草稿 ← 未使用の既存行（position 順）＝編集された行
 * 3. どの草稿にも対応しない既存行は removed（削除対象。子孫の掃除は呼び出し側）
 *
 * existing は position 昇順で渡すこと。
 */
export interface DraftMatch<Row> {
  /** drafts[i] に対応する既存行（新規行は undefined） */
  assigned: (Row | undefined)[];
  /** どの草稿にも対応しない既存行（削除対象） */
  removed: Row[];
}

export function matchDraftsToExisting<Row extends { content: string }>(
  existing: readonly Row[],
  drafts: readonly { content: string }[],
): DraftMatch<Row> {
  const queueByContent = new Map<string, Row[]>();
  for (const row of existing) {
    const queue = queueByContent.get(row.content) ?? [];
    queue.push(row);
    queueByContent.set(row.content, queue);
  }
  const assigned: (Row | undefined)[] = drafts.map((d) => queueByContent.get(d.content)?.shift());

  const used = new Set(assigned.filter((r) => r !== undefined));
  const leftovers = existing.filter((r) => !used.has(r));
  for (const [i, r] of assigned.entries()) {
    if (r === undefined) assigned[i] = leftovers.shift();
  }
  // shift で消費されずに残った行 = どの草稿にも対応しない削除対象
  return { assigned, removed: leftovers };
}
