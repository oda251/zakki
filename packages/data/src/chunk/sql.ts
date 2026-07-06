import { sql } from "drizzle-orm";

/**
 * chunk ツリーの共有 SQL フラグメント。
 * 再帰 CTE の定義が複数クエリモジュールへ複製されるとドリフト源になるため、
 * ここに一本化する（chunk/queries.ts と graph/queries.ts が参照）。
 */

/**
 * 祖先の日付チャンクの date を全チャンクへ写す再帰 CTE。
 * `roots(id, root_date)` を定義する（トップレベル = 自身の date、子孫 = 祖先の date）。
 */
export const ROOT_DATE_CTE = sql`
  WITH RECURSIVE roots(id, root_date) AS (
    SELECT id, date FROM chunks WHERE parent_id IS NULL
    UNION ALL
    SELECT c.id, r.root_date FROM chunks c JOIN roots r ON c.parent_id = r.id
  )
`;
