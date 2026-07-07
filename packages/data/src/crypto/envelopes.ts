import { eq } from "drizzle-orm";
import { unwrapDek, wrapDek } from "@zakki/core/crypto/dek.ts";
import { defaultKdfParams, deriveKey, generateSalt } from "@zakki/core/crypto/kdf.ts";
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

/** 1 つの封筒を upsert する（kind が主キー）。 */
async function upsertEnvelope(
  db: Db,
  kind: EnvelopeKind,
  wrappedDek: Uint8Array,
  kdf: { salt: Uint8Array; ops: number; mem: number } | null,
): Promise<void> {
  const row = {
    kind,
    wrappedDek: Buffer.from(wrappedDek),
    kdfSalt: kdf === null ? null : Buffer.from(kdf.salt),
    kdfOps: kdf === null ? null : kdf.ops,
    kdfMem: kdf === null ? null : kdf.mem,
    createdAt: new Date().toISOString(),
  };
  await db
    .insert(keyEnvelopes)
    .values(row)
    .onConflictDoUpdate({
      target: keyEnvelopes.kind,
      set: {
        wrappedDek: row.wrappedDek,
        kdfSalt: row.kdfSalt,
        kdfOps: row.kdfOps,
        kdfMem: row.kdfMem,
        createdAt: row.createdAt,
      },
    });
}

/** kind の封筒を 1 行読む（無ければ undefined）。 */
async function readEnvelope(db: Db, kind: EnvelopeKind) {
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
  return (await readEnvelope(db, kind)) !== undefined;
}

/** 存在する封筒の kind 一覧を返す。 */
export async function listEnvelopeKinds(db: Db): Promise<EnvelopeKind[]> {
  const rows = await db.select({ kind: keyEnvelopes.kind }).from(keyEnvelopes);
  return rows.map((r) => r.kind);
}
