import type { Editing } from "@zakki/core/input/store.ts";

/**
 * 編集確定 / 削除で確定した「何を反映するか」の分類（docs/PANES.md §4, §7）。
 * shell はこの plan を interpret（setRaw / updateChunkContent / deleteChunk / export）するだけ。
 * - revert: 空確定は編集を破棄して元に戻す（削除しない）。
 * - rawReplace: 当日 raw のリテラル領域 [start, end) を text で置換（text="" は削除）。
 * - detailUpdate: 過去日・深い階層のチャンクを id 直更新し、当該日を再エクスポート。
 * - detailDelete: 過去日・深い階層のチャンクを id 直削除し、当該日を再エクスポート。
 */
export type EditPlan =
  | { kind: "revert" }
  | { kind: "rawReplace"; start: number; end: number; text: string }
  | { kind: "detailUpdate"; chunkId: number; text: string; date: string }
  | { kind: "detailDelete"; chunkId: number; date: string };

/**
 * planEditCommit の文脈依存入力（shell 側から注入する）。
 * - parentId: detail 編集対象の親 id（当日直下判定に使う。不明なら -1）。
 * - resolveBlock: 当日 raw から position のリテラル領域を再解決する（stale offset 回避）。
 *   解決できなければ null（＝当該チャンクが見つからずエラー表示）。
 */
export interface EditCommitCtx {
  today: string;
  dateChunkId: number;
  parentId: number;
  resolveBlock: (position: number) => { start: number; end: number } | null;
}

/**
 * 修正確定の分類（純粋関数）。副作用は持たず EditPlan を返す。
 * 分類ルール（docs/PANES.md §4, §7 の現挙動）:
 * - text.trim()==="" → revert（空確定は元に戻す）
 * - main → rawReplace（リテラル領域を打ち直しテキストで置換）
 * - detail かつ 当日直下（date===today && parentId===dateChunkId）→ resolveBlock で rawReplace
 *   （raw が正本のため領域を書き換える。解決失敗は null＝エラー表示）
 * - detail かつそれ以外（過去日・深い階層）→ detailUpdate（id 直更新）
 * 削除は本関数を通さず、shell が rawReplace(text="") / detailDelete を組み立てる。
 */
export function planEditCommit(editing: Editing, ctx: EditCommitCtx): EditPlan | null {
  const text = editing.text.trim();
  if (text === "") {
    return { kind: "revert" };
  }
  const target = editing.target;
  if (target.kind === "main") {
    return { kind: "rawReplace", start: target.start, end: target.end, text };
  }
  if (target.date === ctx.today && ctx.parentId === ctx.dateChunkId) {
    const block = ctx.resolveBlock(target.position);
    return block === null ? null : { kind: "rawReplace", start: block.start, end: block.end, text };
  }
  return { kind: "detailUpdate", chunkId: target.chunkId, text, date: target.date };
}
