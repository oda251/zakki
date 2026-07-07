import { currentHref, pushHref, replaceHref } from "@zakki/web/client/router/history.ts";
import { formatRoute, parseRoute, type Route } from "@zakki/web/client/router/route.ts";

/**
 * ナビゲーションヘルパ（issue #52）。コンポーネントは store のアクションではなく
 * ここを呼び、URL（SSOT）を書き換える。バッファのロードは controller.ts が
 * URL 変化に追随して行う。
 * - チャンク遷移（ドリル）= push（戻る/進むの履歴になる）
 * - 選択・フィルタ = replace（履歴を汚さない）。フィルタはチャンク遷移を跨いで維持する
 */

function push(route: Route): void {
  pushHref(formatRoute(route));
}

function replace(route: Route): void {
  replaceHref(formatRoute(route));
}

function current(): Route {
  return parseRoute(currentHref());
}

/** チャンク :id へ潜る。選択は明示指定が無ければ解除する */
export function gotoChunk(id: number, select: number | null = null): void {
  push({ ...current(), chunk: { kind: "chunk", id }, select });
}

/** トップレベル（日付チャンク層の全体）へ */
export function gotoAll(select: number | null = null): void {
  push({ ...current(), chunk: { kind: "all" }, select });
}

/** 当日の日付チャンクへ（既定画面） */
export function gotoToday(): void {
  push({ ...current(), chunk: { kind: "today" }, select: null });
}

/** ノード選択（?select=）。null で解除 */
export function selectNode(id: number | null): void {
  const route = current();
  replace({ ...route, select: id });
}

/** 自動タグフィルタ（?tag=）。null で解除 */
export function setTagFilter(tag: string | null): void {
  const route = current();
  replace({ ...route, filter: { ...route.filter, tag } });
}

/** ユーザタグフィルタ（?utag=）。null で解除 */
export function setUserTagFilter(userTag: string | null): void {
  const route = current();
  replace({ ...route, filter: { ...route.filter, userTag } });
}
