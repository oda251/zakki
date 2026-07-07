import type { ResultSet } from "@libsql/client";

/**
 * 生 SQL（db.run）の結果行を Row 型として読む唯一の型境界。
 *
 * libSQL の ResultSet.rows は untyped（Row = 値の連想配列）なので、SELECT の別名列と
 * 1:1 対応する Row 型への読み替えはここに集約する。呼び出し側は `rowsAs<XxxRow>(res)` と
 * 型名を明示し、Row 型自体は schema 派生（Pick<Chunk> 等、#50）にすることで、
 * 列の変更をコンパイルエラーとして検出する。個別の as キャストは
 * typescript/consistent-type-assertions（#51）で禁止している。
 */
export function rowsAs<T>(res: ResultSet): T[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- 生 SQL → 型付き Row の境界。ここ以外での as は禁止（#51）
  return res.rows as unknown as T[];
}
