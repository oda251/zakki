import type { Db } from "@zakki/data/db/client.ts";
import type { FileStore } from "@zakki/web/server/files/store.ts";

/** リクエストの中継先（DB）とアカウント（R2 オブジェクトキーの名前空間）。 */
export interface ResolvedUser {
  readonly db: Db;
  readonly accountId: string;
}

/** リクエスト → その利用者（未認証・解決不能なら null） */
export type ResolveUser = (req: Request) => Promise<ResolvedUser | null>;

/**
 * 単一ユーザ self-host（`resolveUser` 未指定）の accountId。中継先が常に 1 つ
 * （{@link AppDeps.db}）しか無いため、実際のアカウント識別子を持たずとも
 * オブジェクトキーの名前空間として固定値で足りる。
 */
export const LOCAL_ACCOUNT_ID = "local";

/**
 * ルートが使う依存の束。index.ts（本番合成点）とテストが注入する。
 * サーバは暗号文の中継（replication / 封筒配布）とファイル実体の中継（R2）のみで、
 * DEK・FEK・復号・解析・変換（かな漢字変換は web では #149 で撤去。TUI が自前変換を持つだけ）は持たない。
 */
export interface AppDeps {
  /**
   * 単一ユーザ self-host（既定）で中継する DB。
   *
   * マルチユーザ専用の配備（Workers, issue #134）では**持たない**: 中継先は
   * リクエストごとに {@link AppDeps.resolveUser} が決めるので、フォールバック先の
   * ローカル DB を開く意味が無い（Workers にファイルシステムも無い）。
   */
  db?: Db;
  /**
   * マルチユーザ構成（issue #105）でのリクエスト単位の中継先解決。
   * 未指定なら常に `{ db, accountId: LOCAL_ACCOUNT_ID }`（単一ユーザ self-host）。
   */
  resolveUser?: ResolveUser;
  /**
   * コントロールプレーン（apps/api）の base URL。設定されているときだけ
   * クライアントはリモート構成（RemoteIdentity）で起動する。秘密ではない
   * （公開エンドポイントの所在）ので `GET /api/config` で配る。
   */
  controlPlaneUrl?: string;
  /**
   * R2 binding のアダプタ（issue #157）。単一ユーザ self-host で R2 を持たない
   * 配備では未指定になり、ファイル経路（`/api/files/*`）は 503 を返す。
   */
  files?: FileStore;
  /**
   * multipart の平文 part サイズ。既定は `DEFAULT_PART_BYTES`
   * （`@zakki/core/file/upload.ts`）。テストが小さい値を注入して分割を検証する。
   */
  partSize?: number;
}

/**
 * このリクエストが中継すべき利用者を返す。マルチユーザ構成で解決できない
 * （未ログイン・セッション失効）場合は null で、呼び出し側が 401 を返す。
 *
 * マルチユーザ専用の配備では `db` が無いので、解決できなければ素直に null になる
 * （フォールバック先が無い = 認証されていないリクエストは何も中継しない）。
 */
export async function userForRequest(deps: AppDeps, req: Request): Promise<ResolvedUser | null> {
  if (deps.resolveUser !== undefined) return await deps.resolveUser(req);
  return deps.db === undefined ? null : { db: deps.db, accountId: LOCAL_ACCOUNT_ID };
}

/** {@link userForRequest} の DB だけを見る従来経路（replication / 封筒配布）向けの薄い委譲。 */
export async function dbForRequest(deps: AppDeps, req: Request): Promise<Db | null> {
  return (await userForRequest(deps, req))?.db ?? null;
}
