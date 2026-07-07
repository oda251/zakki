import { sql } from "drizzle-orm";

/**
 * chunk ツリーの共有 SQL フラグメント。
 * 再帰 CTE の定義が複数クエリモジュールへ複製されるとドリフト源になるため、
 * ここに一本化する（chunk/queries.ts と graph/queries.ts が参照）。
 */

/**
 * 祖先の日付チャンクの date を全チャンクへ写す再帰 CTE。
 * `roots(id, root_date)` を定義する（トップレベル = 自身の date、子孫 = 祖先の date）。
 *
 * この CTE と組む SELECT の別名列は、キャスト先の Row 型（schema.ts の Chunk からの
 * Pick 派生、#50）と 1:1 対応させること:
 * - chunk/queries.ts: RawChunkRow（= ChunkWithDate。id/parentId/position/content/date/polarity）
 * - graph/queries.ts: RawNodeRow（上記 + ownDate = 自身の date 列）
 * 生 SQL は列名文字列（snake_case）を型検査できないため、TS プロパティ名の変更は
 * Pick 派生で検出し、SQL 列名の変更はこの相互参照コメントを手がかりに追随する。
 */
export const ROOT_DATE_CTE = sql`
  WITH RECURSIVE roots(id, root_date) AS (
    SELECT id, date FROM chunks WHERE parent_id IS NULL
    UNION ALL
    SELECT c.id, r.root_date FROM chunks c JOIN roots r ON c.parent_id = r.id
  )
`;
