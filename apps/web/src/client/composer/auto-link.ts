import type { ChunkTarget } from "@zakki/web/client/router/route.ts";

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

export interface AutoLinkPlan {
  /** 永続化するリンク列 */
  links: LinkDraft[];
  /** URL の ?select= へ移す最新チャンク id */
  select: number;
}

/**
 * 保存応答に対する auto-link（リンク永続化 + 選択更新）の計画。
 * バッファ切替後に後着した保存（デバウンス保存はデータ保全のため切替後も走らせる）
 * では null を返し、副作用を保存先バッファに固定する（PR #79 レビュー対応）:
 * 切替先 URL の ?select= をアンカーに読むとバッファを跨いだ誤リンクが永続化され、
 * 選択更新は切替先 URL の ?select= を旧バッファのチャンク id で上書きしてしまう。
 * 同一性は発火時点の URL（/c/:id は id、"/"・"/all" は解決済みバッファ id）で判定する。
 */
export function planAutoLink(args: {
  /** 保存先（この Composer の親チャンク）id */
  parentId: number;
  /** アンカー（選択中の投稿）。保存を予約した時点で捕捉した値 */
  anchor: number | null;
  /** 発火時点の URL のチャンク対象 */
  chunk: ChunkTarget;
  /** 発火時点の解決済みバッファ id（"/"・"/all" の当日判定。ロード中は null） */
  currentId: number | null;
  /** 保存応答から検出した新チャンク id（保存順） */
  freshIds: readonly number[];
}): AutoLinkPlan | null {
  const last = args.freshIds.at(-1);
  if (last === undefined) return null;
  const openId = args.chunk.kind === "chunk" ? args.chunk.id : args.currentId;
  if (openId !== args.parentId) return null;
  return { links: chainLinks(args.anchor, args.freshIds), select: last };
}
