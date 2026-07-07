import type { GraphFilter } from "@zakki/web/client/store/graph-core.ts";

/**
 * URL ルーティングの純粋ロジック（issue #52）。URL を SSOT にする:
 *
 * ```
 * /            … 当日の日付チャンク（既定）
 * /all         … トップレベル（日付チャンク層の全体グラフ。バッファは当日）
 * /c/:id       … チャンク :id を開く（バッファ＝グラフのドリル位置）
 *   ?select=<id>            … 選択ノード
 *   ?tag=<name> / ?utag=…   … フィルタ（自動タグ / ユーザタグ）
 * ```
 *
 * ここは文字列 ⇄ Route の変換だけを持ち、history / DOM へは触れない
 * （ブラウザ配線は history.ts・controller.ts）。
 */

/** URL が指すバッファ（＝ドリル位置） */
export type ChunkTarget = { kind: "today" } | { kind: "all" } | { kind: "chunk"; id: number };

export interface Route {
  chunk: ChunkTarget;
  /** 選択ノード id（?select=） */
  select: number | null;
  filter: GraphFilter;
}

function parseId(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  return Number(value);
}

/** pathname+search（例: "/c/12?select=3&tag=x"）を Route へ。不明なパスは当日へ倒す */
export function parseRoute(href: string): Route {
  const url = new URL(href, "http://zakki.invalid");
  let chunk: ChunkTarget = { kind: "today" };
  if (url.pathname === "/all") {
    chunk = { kind: "all" };
  } else {
    const id = parseId(/^\/c\/([^/]+)$/.exec(url.pathname)?.[1] ?? null);
    if (id !== null) chunk = { kind: "chunk", id };
  }
  const q = url.searchParams;
  return {
    chunk,
    select: parseId(q.get("select")),
    filter: { tag: q.get("tag"), userTag: q.get("utag") },
  };
}

/** Route を pathname+search へ（parseRoute の逆） */
export function formatRoute(route: Route): string {
  const path =
    route.chunk.kind === "chunk"
      ? `/c/${route.chunk.id}`
      : route.chunk.kind === "all"
        ? "/all"
        : "/";
  const q = new URLSearchParams();
  if (route.select !== null) q.set("select", String(route.select));
  if (route.filter.tag !== null) q.set("tag", route.filter.tag);
  if (route.filter.userTag !== null) q.set("utag", route.filter.userTag);
  const qs = q.toString();
  return qs === "" ? path : `${path}?${qs}`;
}

/**
 * グラフのドリル位置（null = トップレベル）。"today" は URL に id を持たないため、
 * バッファが解決した当日チャンク id（ロード完了まで null）を写す。
 */
export function drillIdOf(chunk: ChunkTarget, todayId: number | null): number | null {
  if (chunk.kind === "chunk") return chunk.id;
  return chunk.kind === "today" ? todayId : null;
}

/** バッファのロード単位のキー。today と all は同じ「当日バッファ」を共有する */
export function bufferKeyOf(chunk: ChunkTarget): string {
  return chunk.kind === "chunk" ? `chunk:${chunk.id}` : "today";
}
