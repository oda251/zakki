import type { Db } from "@zakki/data/db/client.ts";
import type { ResolveDb } from "@zakki/web/server/identity/remote.ts";

/**
 * ルートが使う依存の束。index.ts（本番合成点）とテストが注入する。
 * サーバは暗号文の中継（replication / 封筒配布）のみで、DEK・復号・解析・変換
 * （かな漢字変換は #26 でクライアント wasm 実行へ移設）は持たない。
 */
export interface AppDeps {
  /**
   * 単一ユーザ self-host（既定）で中継する DB。
   *
   * マルチユーザ専用の配備（Workers, issue #134）では**持たない**: 中継先は
   * リクエストごとに {@link AppDeps.resolveDb} が決めるので、フォールバック先の
   * ローカル DB を開く意味が無い（Workers にファイルシステムも無い）。
   */
  db?: Db;
  /**
   * マルチユーザ構成（issue #105）でのリクエスト単位の中継先解決。
   * 未指定なら常に {@link AppDeps.db}（従来どおり）。
   */
  resolveDb?: ResolveDb;
  /**
   * コントロールプレーン（apps/api）の base URL。設定されているときだけ
   * クライアントはリモート構成（RemoteIdentity）で起動する。秘密ではない
   * （公開エンドポイントの所在）ので `GET /api/config` で配る。
   */
  controlPlaneUrl?: string;
}

/**
 * このリクエストが中継すべき DB を返す。マルチユーザ構成で解決できない
 * （未ログイン・セッション失効）場合は null で、呼び出し側が 401 を返す。
 *
 * マルチユーザ専用の配備では `db` が無いので、解決できなければ素直に null になる
 * （フォールバック先が無い = 認証されていないリクエストは何も中継しない）。
 */
export async function dbForRequest(deps: AppDeps, req: Request): Promise<Db | null> {
  return deps.resolveDb === undefined ? (deps.db ?? null) : await deps.resolveDb(req);
}
