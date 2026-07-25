import { eq } from "drizzle-orm";
import { err, ok, type Result } from "neverthrow";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { accountDatabases } from "@zakki/api/db/schema.ts";
import type { PlatformFailure, TursoDatabase, TursoPlatform } from "@zakki/api/turso/platform.ts";

/**
 * アカウントごとの Turso DB プロビジョニング（issue #101）。
 *
 * 「台帳を引く → 無ければ作る → 台帳へ書く」だけを担い、トークン発行は含めない
 * （トークンは都度発行・短命で、台帳にもここにも残さない）。
 *
 * 書き込むのは DB の所在（名前・ホスト名）のみ。E2E を破らないため、鍵・DEK・
 * 本文はコントロールプレーンのどこにも置かない（db/schema.ts の注記のとおり）。
 */

/** DB 名の接頭辞。Turso の命名規則（小文字英数とダッシュ・64 文字以内）に収まる */
const DB_NAME_PREFIX = "zakki-u-";

/** 名前に使う accountId ダイジェストの長さ（バイト）。128bit で衝突は無視できる */
const DIGEST_BYTES = 16;

/**
 * accountId から DB 名を決定的に導く。
 *
 * 決定的なのは冪等性のため: 「DB は作れたが台帳に書く前に落ちた」再試行で同じ名前を
 * 引き当てられないと、二重作成か迷子の DB が生まれる。
 *
 * accountId をそのまま埋めずに SHA-256 の先頭 16 バイトにするのは、
 * (1) accountId の形式（現状 UUID）に名前が依存しないこと、
 * (2) DB のホスト名は DNS・TLS SNI に出るため、そこにアカウント識別子を平文で
 *     載せないこと——の 2 点による。ダイジェストなので同じ accountId からは常に
 * 同じ名前が出る。
 */
export async function databaseNameForAccount(accountId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accountId));
  const hex = Array.from(new Uint8Array(digest).slice(0, DIGEST_BYTES), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `${DB_NAME_PREFIX}${hex}`;
}

/** libsql の接続 URL。クライアントはこれと短命トークンで自分の DB を開く */
export function databaseUrl(hostname: string): string {
  return `libsql://${hostname}`;
}

/** プロビジョニングの失敗。Platform API 由来のものはそのまま透過させる */
export type ProvisionFailure =
  | PlatformFailure
  | { readonly kind: "vanished"; readonly detail: string };

/**
 * accountId に対応する DB を用意して所在を返す（既にあれば作らない）。
 *
 * 冪等性は 2 段で担保する:
 * 1. 台帳を先に引く。2 回目以降は Platform API を一切叩かない
 * 2. 台帳に無ければ作成し、409（already exists）は失敗ではなく「前回の試行が
 *    台帳書き込み前に落ちた」と解釈して既存 DB を引き当てる
 *
 * 台帳への INSERT が競合（同一アカウントの並行リクエスト）した場合も、名前が
 * 決定的なので既存行と同じ内容になる。上書きせず何もしない。
 */
export async function ensureUserDatabase(
  db: ControlDb,
  platform: TursoPlatform,
  accountId: string,
  now: number,
): Promise<Result<TursoDatabase, ProvisionFailure>> {
  const rows = await db
    .select()
    .from(accountDatabases)
    .where(eq(accountDatabases.accountId, accountId))
    .limit(1);
  const ledger = rows[0];
  if (ledger !== undefined) {
    return ok({ name: ledger.dbName, hostname: ledger.dbHostname });
  }

  const name = await databaseNameForAccount(accountId);
  const created = await platform.createDatabase(name);
  let database: TursoDatabase;
  if (created.isOk()) {
    database = created.value;
  } else if (created.error.kind === "conflict") {
    const found = await platform.getDatabase(name);
    if (found.isErr()) return err(found.error);
    if (found.value === null) {
      // already exists と言われた直後に引けない = Platform API 側の不整合。
      // 作り直すと他人の DB を踏む可能性があるので握りつぶさず失敗させる
      return err({ kind: "vanished", detail: `作成済みのはずの DB ${name} を取得できません` });
    }
    database = found.value;
  } else {
    return err(created.error);
  }

  await db
    .insert(accountDatabases)
    .values({
      accountId,
      dbName: database.name,
      dbHostname: database.hostname,
      createdAt: new Date(now).toISOString(),
    })
    .onConflictDoNothing();
  return ok(database);
}
