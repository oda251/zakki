/**
 * API のマウントプレフィクスの SSOT（issue #56）。
 * サーバの mount（server/app.ts）・クライアントの fetch（client/api/client.ts /
 * client/api/events.ts）・vite dev proxy（apps/web/vite.config.ts）が共有する。
 */
export const API_BASE = "/api";
