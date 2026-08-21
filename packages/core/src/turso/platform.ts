import { err, ok, type Result } from "neverthrow";
import * as v from "valibot";

/**
 * Turso Platform API クライアント（issue #101, docs/RESEARCH.md §7）。
 *
 * Turso は IaC を提供も推奨もしておらず（docs 全ページ索引 https://docs.turso.tech/llms.txt に
 * terraform / pulumi の語が無い）、公式の管理手段は CLI と Platform API だけ。zakki は
 * group・DB とも**アプリ側**で作る（issue #129）。使うのは 5 つ:
 * - group 取得 `GET /v1/organizations/{org}/groups/{group}`
 *   （https://docs.turso.tech/api-reference/groups/retrieve）
 * - group 作成 `POST /v1/organizations/{org}/groups`
 *   （https://docs.turso.tech/api-reference/groups/create）
 * - DB 作成 `POST /v1/organizations/{org}/databases`（group 指定）
 * - DB トークン発行 `POST /v1/organizations/{org}/databases/{db}/auth/tokens`
 *   （https://docs.turso.tech/api-reference/databases/create-token）
 * - DB 削除 `DELETE /v1/organizations/{org}/databases/{db}`（退会, issue #116）
 *   （https://docs.turso.tech/api-reference/databases/delete）
 *
 * apps/api（Worker）とブートストラップ CLI の両方から使うため packages/core に置く
 * （issue #130）。app 間の import は depcruise（api-control-plane-standalone /
 * web-no-api-runtime）で禁じられており、共有点は core しかない。
 *
 * Workers ランタイム制約により fetch と Web 標準 API のみで書く（node 組込み・Bun 固有 API は禁止、
 * scripts/check-arch-guards.sh Guard 5）。base URL を設定にしてあるのはテストが
 * fake Platform API（Hono をテスト側の serve に載せたもの）を向けられるようにするため——本物の Turso は
 * ローカルで再現できないので、プロトコルレベルで差し替える。
 *
 * ここに現れるのは DB の所在とアクセストークンだけで、E2E の鍵材料（DEK・封筒・本文）は
 * 一切通らない。発行するトークンは「そのユーザの DB を開ける権限」であって復号鍵ではない。
 */

/** Turso Platform API の既定 base URL。合成点（apps/api/src/index.ts・CLI）が使う */
export const TURSO_API_BASE_URL = "https://api.turso.tech";

/**
 * group を作るときの既定ロケーション（東京）。
 *
 * 現行 API のロケーションキーは AWS リージョン形式で、旧 3 文字コード `nrt` は
 * 400 `invalid location` で弾かれる（2026-08-19 実測, issue #129）。
 * 有効な一覧は `GET https://api.turso.tech/v1/locations`
 * （https://docs.turso.tech/api-reference/locations/list）、最寄りは https://region.turso.io 。
 */
export const TURSO_DEFAULT_LOCATION = "aws-ap-northeast-1";

/** 接続設定。合成点が検証済み env（apps/api/src/env.ts）から組み立てる */
export interface TursoPlatformConfig {
  /** API の base URL（末尾スラッシュ無し）。テストは fake サーバを指す */
  readonly baseUrl: string;
  /** Platform API トークン（組織スコープ。ユーザには絶対に渡さない） */
  readonly apiToken: string;
  /** organization slug */
  readonly organization: string;
  /** DB を作る group 名。存在しなければ {@link TursoPlatform.ensureGroup} が作る */
  readonly group: string;
  /** group を新規作成するときの primary ロケーション。既定は {@link TURSO_DEFAULT_LOCATION} */
  readonly groupLocation?: string;
}

/** Platform API が返す DB の所在。台帳に載るのはこの 2 つだけ */
export interface TursoDatabase {
  readonly name: string;
  readonly hostname: string;
}

/**
 * 失敗の分類。`conflict` だけは呼び出し側が「既にある」＝成功へ畳めるので
 * 他の HTTP エラーと区別する（プロビジョニングの冪等性, apps/api/src/turso/provision.ts）。
 * detail は運用ログ用で、そのままクライアントへ返さない（Platform API の
 * 内部メッセージ・組織名が wire に漏れるため）。
 */
export type PlatformFailure =
  | { readonly kind: "conflict" }
  | { readonly kind: "unreachable"; readonly detail: string }
  | { readonly kind: "status"; readonly status: number; readonly detail: string }
  | { readonly kind: "malformed"; readonly detail: string };

/** DB トークンの発行条件 */
export interface TokenRequest {
  /** Turso の期間表記（例 "1h"、"2w1d30m"）。省略時の API 既定は never なので必ず渡す */
  readonly expiration: string;
  /** 権限。ジャーナル DB は読み書きするので full-access */
  readonly authorization: "full-access" | "read-only";
}

/** 作成・取得のレスポンス（未知のフィールドは valibot が落とす） */
const DatabaseSchema = v.object({
  database: v.object({
    Name: v.pipe(v.string(), v.minLength(1)),
    Hostname: v.pipe(v.string(), v.minLength(1)),
  }),
});

/**
 * group のレスポンス。読むのは名前だけにする: 作成と取得で形が揃っておらず
 * （取得は `locations: ["aws-us-east-1"]` と `primary: "us-east-1"` を併記する。
 * https://docs.turso.tech/api-reference/groups/retrieve ）、使わない値の形に
 * 縛られると API の揺れで壊れるため。
 */
const GroupSchema = v.object({ group: v.object({ name: v.pipe(v.string(), v.minLength(1)) }) });

/** トークン発行のレスポンス */
const TokenSchema = v.object({ jwt: v.pipe(v.string(), v.minLength(1)) });

export interface TursoPlatform {
  /**
   * 設定の group を存在させる（引ければ何もしない・無ければ作る）。冪等。
   *
   * DB は必ず group に属するため、group の無い組織では `createDatabase` が失敗する。
   * 返すのは成否だけ: 呼び出し側が要るのは「作れる状態か」であって group の属性ではない。
   */
  ensureGroup(): Promise<Result<void, PlatformFailure>>;
  /** DB を作る。同名が既にあれば `conflict`（呼び出し側が畳む） */
  createDatabase(name: string): Promise<Result<TursoDatabase, PlatformFailure>>;
  /** DB を引く。存在しなければ null（404 はエラーではない） */
  getDatabase(name: string): Promise<Result<TursoDatabase | null, PlatformFailure>>;
  /** DB スコープのトークンを発行する。戻り値は JWT 文字列 */
  issueToken(name: string, request: TokenRequest): Promise<Result<string, PlatformFailure>>;
  /**
   * DB を消す（退会, issue #116）。存在しなければ成功に畳む（404 はエラーではない）。
   * 冪等なのは退会が「DB 削除 → 台帳削除」の 2 段で、間で落ちた再試行が必ず
   * 「もう無い DB を消す」形になるため。
   */
  deleteDatabase(name: string): Promise<Result<void, PlatformFailure>>;
}

/** レスポンス本文の先頭だけをログ用に取る（巨大な HTML エラーページ対策） */
async function detailOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return text.slice(0, 200);
}

export function createTursoPlatform(config: TursoPlatformConfig): TursoPlatform {
  const org = encodeURIComponent(config.organization);
  const base = `${config.baseUrl}/v1/organizations/${org}/databases`;
  const groupsBase = `${config.baseUrl}/v1/organizations/${org}/groups`;

  /**
   * 共通のリクエスト。ネットワーク例外（DNS・接続断）だけを捕まえ、
   * HTTP ステータスの解釈は呼び出し側に任せる。
   */
  async function send(url: string, init: RequestInit): Promise<Result<Response, PlatformFailure>> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${config.apiToken}`);
    try {
      return ok(await fetch(url, { ...init, headers }));
    } catch (e) {
      return err({ kind: "unreachable", detail: String(e) });
    }
  }

  /** 200 の本文を DatabaseSchema で検証して TursoDatabase へ写す */
  async function readDatabase(res: Response): Promise<Result<TursoDatabase, PlatformFailure>> {
    const body: unknown = await res.json().catch(() => null);
    const parsed = v.safeParse(DatabaseSchema, body);
    if (!parsed.success) {
      return err({ kind: "malformed", detail: "database レスポンスの形が想定と違います" });
    }
    return ok({ name: parsed.output.database.Name, hostname: parsed.output.database.Hostname });
  }

  return {
    async ensureGroup() {
      const found = await send(`${groupsBase}/${encodeURIComponent(config.group)}`, {
        method: "GET",
      });
      if (found.isErr()) return err(found.error);
      if (found.value.ok) {
        // 本文を読むのは「group と名乗るものが返った」ことの確認のため。
        // 形が違うなら別物を掴んでいる可能性があるので作成へ進まず落とす
        const body: unknown = await found.value.json().catch(() => null);
        if (!v.safeParse(GroupSchema, body).success) {
          return err({ kind: "malformed", detail: "group レスポンスの形が想定と違います" });
        }
        return ok(undefined);
      }
      if (found.value.status !== 404) {
        return err({
          kind: "status",
          status: found.value.status,
          detail: await detailOf(found.value),
        });
      }

      const created = await send(groupsBase, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: config.group,
          location: config.groupLocation ?? TURSO_DEFAULT_LOCATION,
          // ベクトル検索・全文検索の拡張を有効にしておく（既定では無効）。
          // 後から group の拡張だけを足す API は無いため作成時に決める
          extensions: "all",
        }),
      });
      if (created.isErr()) return err(created.error);
      const res = created.value;
      // 409 = 取得と作成の間に他の実行者（並行するプロビジョニング）が作った。
      // 望む終状態（group がある）に達しているので成功へ畳む
      if (res.status === 409) return ok(undefined);
      if (!res.ok) {
        return err({ kind: "status", status: res.status, detail: await detailOf(res) });
      }
      return ok(undefined);
    },

    async createDatabase(name) {
      const sent = await send(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, group: config.group }),
      });
      if (sent.isErr()) return err(sent.error);
      const res = sent.value;
      // 409 = 同名 DB が既にある。前回の試行が台帳書き込み前に落ちた場合に必ず通る道
      if (res.status === 409) return err({ kind: "conflict" });
      if (!res.ok) {
        return err({ kind: "status", status: res.status, detail: await detailOf(res) });
      }
      return readDatabase(res);
    },

    async getDatabase(name) {
      const sent = await send(`${base}/${encodeURIComponent(name)}`, { method: "GET" });
      if (sent.isErr()) return err(sent.error);
      const res = sent.value;
      if (res.status === 404) return ok(null);
      if (!res.ok) {
        return err({ kind: "status", status: res.status, detail: await detailOf(res) });
      }
      return readDatabase(res);
    },

    async issueToken(name, request) {
      const query = new URLSearchParams({
        expiration: request.expiration,
        authorization: request.authorization,
      });
      const sent = await send(
        `${base}/${encodeURIComponent(name)}/auth/tokens?${query.toString()}`,
        { method: "POST" },
      );
      if (sent.isErr()) return err(sent.error);
      const res = sent.value;
      if (!res.ok) {
        return err({ kind: "status", status: res.status, detail: await detailOf(res) });
      }
      const body: unknown = await res.json().catch(() => null);
      const parsed = v.safeParse(TokenSchema, body);
      if (!parsed.success) {
        return err({ kind: "malformed", detail: "token レスポンスの形が想定と違います" });
      }
      return ok(parsed.output.jwt);
    },

    async deleteDatabase(name) {
      const sent = await send(`${base}/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (sent.isErr()) return err(sent.error);
      const res = sent.value;
      // 404 = 既に無い。「消えている」は退会が望む終状態そのものなので成功に畳む
      // （前回の退会が DB 削除後・台帳削除前に落ちた場合の再試行が必ずここを通る）。
      // 応答本文（`{"database": "<name>"}`）は要求した名前の反復なので読まない
      if (res.status === 404) return ok(undefined);
      if (!res.ok) {
        return err({ kind: "status", status: res.status, detail: await detailOf(res) });
      }
      return ok(undefined);
    },
  };
}
