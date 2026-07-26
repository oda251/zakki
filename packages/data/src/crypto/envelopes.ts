import { and, eq, sql } from "drizzle-orm";
import { unwrapDek, wrapDek } from "@zakki/core/crypto/dek.ts";
import {
  defaultKdfParams,
  deriveKekFromPrf,
  deriveKey,
  generateSalt,
} from "@zakki/core/crypto/kdf.ts";
import { sodium } from "@zakki/core/crypto/sodium.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { EnvelopeKind } from "@zakki/data/db/schema.ts";
import { keyEnvelopes } from "@zakki/data/db/schema.ts";

/**
 * 鍵封筒（key envelopes）の CRUD（Phase 6）。
 *
 * 同一の DEK を複数の KEK で wrap した独立した封筒を `key_envelopes` に保持する。
 * 各封筒は `kind`（keyfile / passphrase / recovery）で区別され、DEK 自体は不変。
 * これにより、データを再暗号化せずにアンロック手段を追加・更新・失効できる。
 *
 * パスフレーズ／リカバリの誤りは、`unwrapDek`（AEAD 認証）が **例外を投げる** ことで
 * 検出する（コードベースの方針どおり、復号失敗＝鍵違い）。
 *
 * 秘密（DEK / KEK / パスフレーズ / リカバリコード）は **絶対にログ出力しない**。
 * 事前に {@link import("@zakki/core/crypto/sodium.ts").ready} 完了が前提。
 */

// 既定の Argon2id パラメータは core 側の defaultKdfParams()（INTERACTIVE プリセット）が
// SSOT（issue #56）。sodium 定数は ready 後にしか値が入らないため、モジュール評価時に
// 捕捉せず各関数の呼び出し時に読む。封筒には使ったパラメータを保存する。

/** Buffer ⇄ Uint8Array のゼロコピー写し（drizzle blob は Buffer で返る）。 */
function toBytes(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * 単数 kind（keyfile / passphrase / recovery）の封筒を upsert する。
 * 衝突先は部分ユニークインデックス `UNIQUE (kind) WHERE kind <> 'passkey'`
 * なので、ON CONFLICT にも同じ WHERE を添える（issue #120）。
 */
async function upsertEnvelope(
  db: Db,
  kind: Exclude<EnvelopeKind, "passkey">,
  wrappedDek: Uint8Array,
  kdf: { salt: Uint8Array; ops: number; mem: number } | null,
): Promise<void> {
  const row = {
    kind,
    wrappedDek: Buffer.from(wrappedDek),
    kdfSalt: kdf === null ? null : Buffer.from(kdf.salt),
    kdfOps: kdf === null ? null : kdf.ops,
    kdfMem: kdf === null ? null : kdf.mem,
    credentialId: null,
    createdAt: new Date().toISOString(),
  };
  await db
    .insert(keyEnvelopes)
    .values(row)
    .onConflictDoUpdate({
      target: keyEnvelopes.kind,
      targetWhere: sql`"kind" <> 'passkey'`,
      set: {
        wrappedDek: row.wrappedDek,
        kdfSalt: row.kdfSalt,
        kdfOps: row.kdfOps,
        kdfMem: row.kdfMem,
        createdAt: row.createdAt,
      },
    });
}

/** 単数 kind の封筒を 1 行読む（無ければ undefined）。 */
async function readEnvelope(db: Db, kind: Exclude<EnvelopeKind, "passkey">) {
  const [row] = await db.select().from(keyEnvelopes).where(eq(keyEnvelopes.kind, kind)).limit(1);
  return row;
}

/** キーファイル KEK で DEK を wrap し、kind='keyfile' を upsert する（ソルト無し）。 */
export async function addKeyfileEnvelope(db: Db, dek: Uint8Array, kek: Uint8Array): Promise<void> {
  await upsertEnvelope(db, "keyfile", wrapDek(dek, kek), null);
}

/**
 * パスフレーズから KEK を導出して DEK を wrap し、kind='passphrase' を upsert する。
 * 使った Argon2id パラメータ（salt/ops/mem）を保存して、アンロック時に再導出できるようにする。
 */
export async function addPassphraseEnvelope(
  db: Db,
  dek: Uint8Array,
  passphrase: string,
): Promise<void> {
  const salt = generateSalt();
  const { opsLimit, memLimit } = defaultKdfParams();
  const kek = deriveKey(passphrase, salt, opsLimit, memLimit);
  await upsertEnvelope(db, "passphrase", wrapDek(dek, kek), {
    salt,
    ops: opsLimit,
    mem: memLimit,
  });
}

/**
 * クライアント側で wrap 済みの passkey 封筒を **credentialId 単位で** upsert する
 * （issue #103 / #120）。この関数は **平文 DEK にも PRF 出力にも触れない**
 * （wrap はクライアントで済んでいる）。KEK は PRF 出力から決定的に導出される
 * （`deriveKekFromPrf`）ため kdf メタは持たない。
 *
 * PRF 出力はクレデンシャル（鍵ペア）ごとに異なるので、封筒もクレデンシャルごとに
 * 1 本持つ（`UNIQUE (credential_id) WHERE kind = 'passkey'`）。同じ credentialId で
 * 呼び直すと再 wrap の上書きになる。
 */
export async function putPasskeyEnvelope(
  db: Db,
  wrappedDek: Uint8Array,
  credentialId: string,
): Promise<void> {
  const row = passkeyRow(wrappedDek, credentialId);
  await db
    .insert(keyEnvelopes)
    .values(row)
    .onConflictDoUpdate({
      target: keyEnvelopes.credentialId,
      targetWhere: sql`"kind" = 'passkey'`,
      set: { wrappedDek: row.wrappedDek, createdAt: row.createdAt },
    });
}

/** passkey 封筒の行（kdf メタは持たない。credentialId が実質の一意キー）。 */
function passkeyRow(wrappedDek: Uint8Array, credentialId: string) {
  return {
    kind: "passkey" as const,
    wrappedDek: Buffer.from(wrappedDek),
    kdfSalt: null,
    kdfOps: null,
    kdfMem: null,
    credentialId,
    createdAt: new Date().toISOString(),
  };
}

/**
 * **既に封筒が 1 つ以上ある DB にだけ** passkey 封筒を upsert する（issue #103 の
 * 409 ガードを SQL 側の条件で表現したもの, issue #120）。
 *
 * 封筒ゼロ（暗号未プロビジョン）の DB に passkey 封筒だけが入ると、
 * `unlockOrSetup` の初回判定（kinds.length === 0）が壊れて PRF を評価できない
 * TUI/CLI から復旧不能になる。件数を **読んでから書く** と、その隙間に他の
 * リクエストが封筒を消す/入れる余地（read-then-write の競合）が生まれるため、
 * 存在判定と書き込みを 1 文（`INSERT ... SELECT ... WHERE EXISTS ... ON CONFLICT`）に
 * まとめて原子的に行う。
 *
 * @returns 書き込めたら true / 封筒ゼロで拒否されたら false
 */
export async function putPasskeyEnvelopeIfProvisioned(
  db: Db,
  wrappedDek: Uint8Array,
  credentialId: string,
): Promise<boolean> {
  const row = passkeyRow(wrappedDek, credentialId);
  // SELECT を伴う INSERT の ON CONFLICT は WHERE 句が無いと構文が曖昧になる
  // （SQLite の仕様。ここでは EXISTS が兼ねる）。
  const inserted = await db.all(sql`
    INSERT INTO ${keyEnvelopes} ("kind", "wrapped_dek", "kdf_salt", "kdf_ops", "kdf_mem", "credential_id", "created_at")
    SELECT ${row.kind}, ${row.wrappedDek}, NULL, NULL, NULL, ${row.credentialId}, ${row.createdAt}
    WHERE EXISTS (SELECT 1 FROM ${keyEnvelopes})
    ON CONFLICT ("credential_id") WHERE "kind" = 'passkey'
    DO UPDATE SET "wrapped_dek" = excluded."wrapped_dek", "created_at" = excluded."created_at"
    RETURNING "id"
  `);
  return inserted.length > 0;
}

/**
 * WebAuthn PRF 出力（32 バイト）から KEK を導出して DEK を wrap し、passkey 封筒を
 * upsert する（issue #103）。PRF 出力を扱えるプロセス（クライアント相当）専用。
 */
export async function addPasskeyEnvelope(
  db: Db,
  dek: Uint8Array,
  prfOutput: Uint8Array,
  credentialId: string,
): Promise<void> {
  await putPasskeyEnvelope(db, wrapDek(dek, deriveKekFromPrf(prfOutput)), credentialId);
}

/**
 * passkey 封筒を 1 本消す（失効。issue #120）。存在しなければ何もしない（冪等）。
 *
 * **クレデンシャル本体はこの DB に無い**: パスキー（公開鍵）はコントロールプレーン DB
 * （apps/api の `DELETE /auth/credentials/:id`, #115）、封筒はユーザ自身のジャーナル DB。
 * 失効はこの 2 つの DB に跨るため、両方を消すのは **クライアントの責務**（2 段階削除）。
 * 片方だけ成功しても致命的ではない: クレデンシャルを失効させればログインも PRF 評価も
 * できないので、残った封筒を開く経路が無い。
 *
 * passkey 封筒を消して「封筒ゼロ」になることは、現状の経路では起きない: passkey 封筒は
 * 既存封筒がある DB にしか作れず（{@link putPasskeyEnvelopeIfProvisioned}）、他の kind を
 * 消す経路も無いため。ただしそれを保証しているのは経路の組み合わせであって、この関数や
 * スキーマの制約ではない（他 kind の削除を足すなら、ここも見直す）。
 *
 * @returns 実際に消えたら true
 */
export async function deletePasskeyEnvelope(db: Db, credentialId: string): Promise<boolean> {
  const deleted = await db
    .delete(keyEnvelopes)
    .where(and(eq(keyEnvelopes.kind, "passkey"), eq(keyEnvelopes.credentialId, credentialId)))
    .returning({ id: keyEnvelopes.id });
  return deleted.length > 0;
}

/** リカバリコードから KEK を導出して DEK を wrap し、kind='recovery' を upsert する。 */
export async function addRecoveryEnvelope(db: Db, dek: Uint8Array, code: string): Promise<void> {
  const salt = generateSalt();
  const { opsLimit, memLimit } = defaultKdfParams();
  const kek = deriveKey(code, salt, opsLimit, memLimit);
  await upsertEnvelope(db, "recovery", wrapDek(dek, kek), {
    salt,
    ops: opsLimit,
    mem: memLimit,
  });
}

/** リカバリコードを構成する Crockford 風 base32 アルファベット（紛らわしい文字を除外）。 */
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECOVERY_GROUPS = 8;
const RECOVERY_GROUP_LEN = 4;

/**
 * 人間が読み書きしやすい高エントロピーのリカバリコードを生成する。
 *
 * 32 文字（8 グループ × 4 文字）をダッシュ区切りで返す。アルファベットは 32 種なので
 * 1 文字 = 5 bit、合計 **160 bit** のエントロピー。文字は `sodium.randombytes_uniform`
 * で偏りなく選ぶ（modulo バイアス無し）。例: `ABCD-EFGH-...`（8 グループ）。
 *
 * これは KDF への入力（パスワード相当）であり、ソルト＋Argon2id を介して KEK になる。
 */
export function generateRecoveryCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < RECOVERY_GROUPS; g++) {
    let group = "";
    for (let i = 0; i < RECOVERY_GROUP_LEN; i++) {
      group += RECOVERY_ALPHABET[sodium.randombytes_uniform(RECOVERY_ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/** kind='keyfile' 封筒をキーファイル KEK で開いて DEK を返す。 */
export async function unlockWithKeyfile(db: Db, kek: Uint8Array): Promise<Uint8Array> {
  const row = await readEnvelope(db, "keyfile");
  if (row === undefined) {
    throw new Error("keyfile envelope not found");
  }
  return unwrapDek(toBytes(row.wrappedDek), kek);
}

/**
 * **そのクレデンシャルの** passkey 封筒を、PRF 出力から再導出した KEK で開いて DEK を
 * 返す（issue #103 / #120）。
 *
 * PRF 出力はクレデンシャル固有なので「どの封筒を開けるか」は認証器を呼んだ側しか
 * 知らない。したがって credentialId を必ず受け取る（封筒を総当たりしない）。
 * PRF 出力違い・封筒改竄は `unwrapDek`（AEAD 認証）が **例外を投げる**。
 */
export async function unlockWithPasskey(
  db: Db,
  prfOutput: Uint8Array,
  credentialId: string,
): Promise<Uint8Array> {
  const [row] = await db
    .select()
    .from(keyEnvelopes)
    .where(and(eq(keyEnvelopes.kind, "passkey"), eq(keyEnvelopes.credentialId, credentialId)))
    .limit(1);
  if (row === undefined) {
    throw new Error("passkey envelope not found");
  }
  return unwrapDek(toBytes(row.wrappedDek), deriveKekFromPrf(prfOutput));
}

/**
 * passkey 封筒に紐づく WebAuthn credential id を **すべて** 返す（無ければ空配列）。
 * `navigator.credentials.get` の allowCredentials に載せて、ユーザが選んだパスキーの
 * id で開ける封筒を引くために使う（issue #120）。
 */
export async function listPasskeyCredentialIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ credentialId: keyEnvelopes.credentialId })
    .from(keyEnvelopes)
    .where(eq(keyEnvelopes.kind, "passkey"));
  return rows.map((r) => r.credentialId).filter((id) => id !== null);
}

/**
 * kind='passphrase' 封筒を、保存済みパラメータでパスフレーズから KEK を再導出して開く。
 * パスフレーズ違いは `unwrapDek` が **例外を投げる**（呼び出し側で再試行ループを組む）。
 */
export async function unlockWithPassphrase(db: Db, passphrase: string): Promise<Uint8Array> {
  return unlockWithDerived(db, "passphrase", passphrase);
}

/** kind='recovery' 封筒を、リカバリコードから KEK を再導出して開く。 */
export async function unlockWithRecovery(db: Db, code: string): Promise<Uint8Array> {
  return unlockWithDerived(db, "recovery", code);
}

/** パスフレーズ／リカバリ共通: 保存済み salt/ops/mem で KEK を再導出して unwrap。 */
async function unlockWithDerived(
  db: Db,
  kind: "passphrase" | "recovery",
  secret: string,
): Promise<Uint8Array> {
  const row = await readEnvelope(db, kind);
  if (row === undefined || row.kdfSalt === null) {
    throw new Error(`${kind} envelope not found`);
  }
  const ops = row.kdfOps ?? defaultKdfParams().opsLimit;
  const mem = row.kdfMem ?? defaultKdfParams().memLimit;
  const kek = deriveKey(secret, toBytes(row.kdfSalt), ops, mem);
  return unwrapDek(toBytes(row.wrappedDek), kek);
}

/**
 * パスフレーズを変更する。新しいソルトで再導出した KEK で DEK を再 wrap し、
 * kind='passphrase' 封筒のみを置き換える。**データ行は一切触らない**（DEK 不変なので
 * 再暗号化は不要）。他の封筒（keyfile / recovery）はそのまま有効。
 */
export async function changePassphrase(
  db: Db,
  dek: Uint8Array,
  newPassphrase: string,
): Promise<void> {
  await addPassphraseEnvelope(db, dek, newPassphrase);
}

/** 指定 kind の封筒が存在するか。 */
export async function hasEnvelope(db: Db, kind: EnvelopeKind): Promise<boolean> {
  const [row] = await db
    .select({ id: keyEnvelopes.id })
    .from(keyEnvelopes)
    .where(eq(keyEnvelopes.kind, kind))
    .limit(1);
  return row !== undefined;
}

/**
 * 存在する封筒の kind 一覧を返す（重複なし）。passkey はクレデンシャルごとに複数行
 * ありうるので distinct を取る（呼び出し側は「手段があるか」だけを見る, issue #120）。
 */
export async function listEnvelopeKinds(db: Db): Promise<EnvelopeKind[]> {
  const rows = await db.selectDistinct({ kind: keyEnvelopes.kind }).from(keyEnvelopes);
  return rows.map((r) => r.kind);
}
