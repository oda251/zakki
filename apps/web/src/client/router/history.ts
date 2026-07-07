/**
 * History API の薄いアダプタ（issue #52）。react-router は使わず、
 * pushState/replaceState + popstate 購読だけで URL を SSOT にする。
 * pushState はイベントを発火しないため、自前ナビゲーションはカスタムイベントで
 * 購読者（useHref / controller）へ通知する。
 */

const NAVIGATE_EVENT = "zakki:navigate";

/** 現在の URL（pathname+search）。Route の素 */
export function currentHref(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function notify(): void {
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

/** 履歴を積んで遷移する（ドリル。戻る/進むの単位） */
export function pushHref(href: string): void {
  if (href === currentHref()) return;
  window.history.pushState(null, "", href);
  notify();
}

/** 現在の履歴エントリを書き換える（選択・フィルタ。履歴を汚さない） */
export function replaceHref(href: string): void {
  if (href === currentHref()) return;
  window.history.replaceState(null, "", href);
  notify();
}

/** URL 変化（戻る/進む + 自前ナビゲーション）の購読。戻り値は購読解除 */
export function subscribeHref(callback: () => void): () => void {
  window.addEventListener("popstate", callback);
  window.addEventListener(NAVIGATE_EVENT, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(NAVIGATE_EVENT, callback);
  };
}
