/**
 * 左メニューのセッション表示名。デフォルトセッション（name = NULL）は
 * 日付 YYYY-MM-DD そのものをタイトルにする（「（日次）」は使わない）。
 */
export function sessionTitle(session: { name: string | null; date: string }): string {
  return session.name ?? session.date;
}
