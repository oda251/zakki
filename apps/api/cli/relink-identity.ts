import { createClient } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { err, ok, type Result } from "neverthrow";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { accountIdentities, accounts } from "@zakki/api/db/schema.ts";
import * as schema from "@zakki/api/db/schema.ts";
import { deleteAccount } from "@zakki/api/turso/provision.ts";
import type { PlatformFailure, TursoPlatform } from "@zakki/core/turso/platform.ts";
import { createTursoPlatform, TURSO_API_BASE_URL } from "@zakki/core/turso/platform.ts";
import { parseDbTokenEnv } from "./env.ts";
import { describeFailure } from "./provision.ts";

/**
 * OIDC 移行の一度きりの運用 CLI（docs/MULTIUSER.md「ログイン（OIDC）」「既存アカウントの
 * 付け替え CLI」）。
 *   bun run relink-identity <fromAccountId> <toAccountId>
 *
 * **なぜ要るか**: パスキー時代のアカウントには identity（`account_identities`）が
 * 無い。OIDC 切り替え後に同じ人が Google でログインすると `(provider, subject)` の
 * 一致先が無いため**新しいアカウント（from）**ができてしまい、既存アカウント（to）の
 * 日記から切り離される。この CLI は from の identity を to へ移し、from を消して
 * 元の日記へ合流させる。
 *
 * **順序が肝**（{@link deleteAccount} と対称の理由）: 「identity を移す → from を
 * 削除する」の順にする。逆順だと from を消した時点でどの account_identities 行を
 * どこへ移すべきか分からなくなる。moved 済みの identity は既に to を指しているため、
 * from の削除（Turso DB 削除込み）に失敗しても**ログインは既に to へ向く**。この状態は
 * 「まだ from の後始末が終わっていない」だけなので、同じコマンドを再実行すれば
 * （2 回目は identity が既に無いので moved: 0 のまま）削除だけをやり直して完了する。
 */

/** 付け替えの失敗。どれも実行前に検知でき、検知した時点では何も変更していない */
export type RelinkFailure =
  | { readonly kind: "same-account" }
  | { readonly kind: "unknown-source"; readonly accountId: string }
  | { readonly kind: "unknown-target"; readonly accountId: string }
  | { readonly kind: "delete-failed"; readonly cause: PlatformFailure };

/**
 * from の identity を to へ移し、from を削除する。
 *
 * 変更前に validate する（同一・未知アカウント）ため、失敗時は DB・Turso とも
 * 一切変更しない。identity の付け替えと from の削除（{@link deleteAccount}）は
 * 別ステップなので、削除だけが失敗しても identity の移動は残る（再実行で完結する）。
 */
export async function relinkIdentities(
  db: ControlDb,
  platform: TursoPlatform,
  { from, to }: { readonly from: string; readonly to: string },
): Promise<Result<{ moved: number }, RelinkFailure>> {
  if (from === to) return err({ kind: "same-account" });

  const [[fromAccount], [toAccount]] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.id, from)).limit(1),
    db.select().from(accounts).where(eq(accounts.id, to)).limit(1),
  ]);
  if (fromAccount === undefined) return err({ kind: "unknown-source", accountId: from });
  if (toAccount === undefined) return err({ kind: "unknown-target", accountId: to });

  // to が既に主 identity を持つと、from の主を移した時点で部分一意インデックス
  // （account ごとに主は高々 1 つ, issue #159）へ衝突する。先に to の主を外し、
  // 移動と一緒に 1 バッチで行う（部分一意チェックは文単位なので demote が先に効く）。
  const [, movedRows] = await db.batch([
    db
      .update(accountIdentities)
      .set({ isPrimary: 0 })
      .where(and(eq(accountIdentities.accountId, to), eq(accountIdentities.isPrimary, 1))),
    db
      .update(accountIdentities)
      .set({ accountId: to })
      .where(eq(accountIdentities.accountId, from))
      .returning({ subject: accountIdentities.subject }),
  ]);
  const moved = movedRows.length;

  const deleted = await deleteAccount(db, platform, from);
  if (deleted.isErr()) return err({ kind: "delete-failed", cause: deleted.error });

  return ok({ moved });
}

/** 失敗を人間向けの 1 行にする */
function describeRelinkFailure(failure: RelinkFailure): string {
  switch (failure.kind) {
    case "same-account":
      return "from と to が同じです（自分自身には付け替えられません）";
    case "unknown-source":
      return `from のアカウント ${failure.accountId} が見つかりません`;
    case "unknown-target":
      return `to のアカウント ${failure.accountId} が見つかりません`;
    case "delete-failed":
      return `identity は to へ移りましたが、from の削除に失敗しました: ${describeFailure(failure.cause)}（同じコマンドを再実行すれば完了します）`;
    default:
      // switch-exhaustiveness-check が網羅を保証するので到達しない
      return "不明な失敗";
  }
}

if (import.meta.main) {
  const [fromAccountId, toAccountId] = process.argv.slice(2);
  if (fromAccountId === undefined || toAccountId === undefined) {
    console.error("使い方: bun run relink-identity <fromAccountId> <toAccountId>");
    process.exit(1);
  }

  // db-token と同じ 2 系統（組織トークン + コントロールプレーン DB）。TTL は使わない
  const config = parseDbTokenEnv(process.env).match(
    (c) => c,
    (message): never => {
      console.error(`zakki relink-identity: ${message}`);
      process.exit(1);
    },
  );

  const client = createClient({ url: config.controlDbUrl, authToken: config.controlDbToken });
  // oxlint-disable-next-line typescript/consistent-type-assertions -- node 版 → web 版の型の読み替え（apps/api のテストと同じ）
  const controlDb = drizzle(client, { schema }) as unknown as ControlDb;

  const platform = createTursoPlatform({
    baseUrl: TURSO_API_BASE_URL,
    apiToken: config.apiToken,
    organization: config.organization,
    // DB 削除に group は要らない（DB は既にある）。設定の形を満たすための既定
    group: "zakki",
  });

  const result = await relinkIdentities(controlDb, platform, {
    from: fromAccountId,
    to: toAccountId,
  });
  client.close();

  if (result.isErr()) {
    console.error(`zakki relink-identity: ${describeRelinkFailure(result.error)}`);
    process.exit(1);
  }
  console.error(
    `zakki relink-identity: ${fromAccountId} → ${toAccountId} へ identity ${result.value.moved} 件を移し、${fromAccountId} を削除しました`,
  );
}
