/**
 * RxDB doc id（string）⇄ UI id（number）の変換と、クライアント採番（issue #44）。
 *
 * RxDB は primaryKey に string を要求し、既存 UI（graph-core / GraphView）は
 * 数値 id 前提のため、境界はこの 2 関数に一元化する。サーバ autoincrement が
 * 無い RxDB 世界では新規 id をクライアントが振る:
 * - 通常チャンク: `Date.now()*1000 + 連番`（~1.7e15。Number.MAX_SAFE_INTEGER 内）
 * - 日付チャンク: 日付から決定的に導出（多端末が同じ日に作っても同一 doc に収束する）。
 *   9e14 台の帯域で、Date.now() 起点の採番（1.7e15 以上）とは重ならない
 */

export const docId = (id: number): string => String(id);

export const numId = (id: string): number => Number(id);

let seq = Math.floor(Math.random() * 1000);

/** 新規チャンク等のクライアント採番。同一ミリ秒内の連番で単一クライアント内は一意 */
export function newDocId(now: number = Date.now()): string {
  seq = (seq + 1) % 1000;
  return String(now * 1000 + seq);
}

const DATE_CHUNK_ID_BASE = 900_000_000_000_000;

/** 日付チャンクの決定的 id（YYYY-MM-DD → 9e14 + yyyymmdd） */
export function dateChunkId(date: string): string {
  return String(DATE_CHUNK_ID_BASE + Number(date.replaceAll("-", "")));
}
