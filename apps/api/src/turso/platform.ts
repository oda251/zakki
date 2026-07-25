import { err, ok, type Result } from "neverthrow";
import * as v from "valibot";

/**
 * Turso Platform API クライアント（issue #101, docs/RESEARCH.md §7）。
 *
 * ユーザごとの DB は数が可変なので IaC（Pulumi）では管理せず、会員登録後に
 * このクライアント経由で実行時生成する。使うのは 2 つだけ:
 * - DB 作成 `POST /v1/organizations/{org}/databases`（group 指定）
 * - DB トークン発行 `POST /v1/organizations/{org}/databases/{db}/auth/tokens`
 *   （https://docs.turso.tech/api-reference/databases/create-token）
 *
 * Workers ランタイム制約により fetch と Web 標準 API のみで書く（node 組込み・Bun 固有 API は禁止、
 * scripts/check-arch-guards.sh Guard 5）。base URL を設定にしてあるのはテストが
 * fake Platform API（Hono をテスト側の serve に載せたもの）を向けられるようにするため——本物の Turso は
 * ローカルで再現できないので、プロトコルレベルで差し替える。
 *
 * ここに現れるのは DB の所在とアクセストークンだけで、E2E の鍵材料（DEK・封筒・本文）は
 * 一切通らない。発行するトークンは「そのユーザの DB を開ける権限」であって復号鍵ではない。
 */

/** Turso Platform API の既定 base URL。合成点（index.ts）が使う */
export const TURSO_API_BASE_URL = "https://api.turso.tech";

/** 接続設定。合成点が検証済み env（env.ts）から組み立てる */
export interface TursoPlatformConfig {
  /** API の base URL（末尾スラッシュ無し）。テストは fake サーバを指す */
  readonly baseUrl: string;
  /** Platform API トークン（組織スコープ。ユーザには絶対に渡さない） */
  readonly apiToken: string;
  /** organization slug */
  readonly organization: string;
  /** DB を作る group 名（事前に存在している必要がある） */
  readonly group: string;
}

/** Platform API が返す DB の所在。台帳に載るのはこの 2 つだけ */
export interface TursoDatabase {
  readonly name: string;
  readonly hostname: string;
}

/**
 * 失敗の分類。`conflict` だけは呼び出し側が「既にある」＝成功へ畳めるので
 * 他の HTTP エラーと区別する（プロビジョニングの冪等性, provision.ts）。
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

/** トークン発行のレスポンス */
const TokenSchema = v.object({ jwt: v.pipe(v.string(), v.minLength(1)) });

export interface TursoPlatform {
  /** DB を作る。同名が既にあれば `conflict`（呼び出し側が畳む） */
  createDatabase(name: string): Promise<Result<TursoDatabase, PlatformFailure>>;
  /** DB を引く。存在しなければ null（404 はエラーではない） */
  getDatabase(name: string): Promise<Result<TursoDatabase | null, PlatformFailure>>;
  /** DB スコープの短命トークンを発行する。戻り値は JWT 文字列 */
  issueToken(name: string, request: TokenRequest): Promise<Result<string, PlatformFailure>>;
}

/** レスポンス本文の先頭だけをログ用に取る（巨大な HTML エラーページ対策） */
async function detailOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return text.slice(0, 200);
}

export function createTursoPlatform(config: TursoPlatformConfig): TursoPlatform {
  const org = encodeURIComponent(config.organization);
  const base = `${config.baseUrl}/v1/organizations/${org}/databases`;

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
  };
}
