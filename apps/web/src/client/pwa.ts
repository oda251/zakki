/**
 * PWA Service Worker 登録モジュール。
 *
 * セキュリティ方針:
 * apps/web/src/server/app.ts の厳格な CSP（script-src 'self'）に準拠するため、
 * HTML へのインラインスクリプト注入（injectRegister）は行わず、
 * バンドル（'self'）内からブラウザ標準 API で登録する。
 */
export function registerPwaServiceWorker(): void {
  if (typeof window !== "undefined" && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          // 定期的にバックグラウンド更新をチェック（1時間ごと）
          setInterval(
            () => {
              void reg.update();
            },
            60 * 60 * 1000,
          );
        })
        .catch((err: unknown) => {
          console.error("zakki-pwa: ServiceWorker registration failed", err);
        });
    });
  }
}
