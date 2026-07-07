/** ローカルタイムゾーンの YYYY-MM-DD（日付チャンクのキー。TUI / web サーバ / web クライアントで共有） */
export function localDate(d: Date = new Date()): string {
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
