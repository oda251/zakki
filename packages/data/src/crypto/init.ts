import { eq } from "drizzle-orm";
import { generateDek, wrapDek } from "@zakki/core/crypto/dek.ts";
import { ready } from "@zakki/core/crypto/sodium.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { CryptoContext } from "@zakki/data/db/crypto-context.ts";
import { attachCrypto, makeCryptoContext } from "@zakki/data/db/crypto-context.ts";
import { chunks, cryptoMeta, embeddings, entries, tags } from "@zakki/data/db/schema.ts";
import {
  addKeyfileEnvelope,
  hasEnvelope,
  unlockWithKeyfile,
} from "@zakki/data/crypto/envelopes.ts";

const ENVELOPE_VERSION = 1;

/**
 * DEK から {@link CryptoContext} を作って Db に登録し、返す（Phase 6）。
 *
 * いずれのアンロック手段（キーファイル / パスフレーズ / リカバリ）で DEK を得た後、
 * データアクセス前に 1 回呼ぶ。`unlockOrSetup` の各分岐から使う共通の出口。
 */
export function provisionCrypto(db: Db, dek: Uint8Array): CryptoContext {
  const ctx = makeCryptoContext(dek);
  attachCrypto(db, ctx);
  return ctx;
}

/**
 * E2E 暗号を初期化し、Db に {@link CryptoContext} を登録して返す（キーファイル単体）。
 *
 * キーファイル封筒が無ければ DEK を新規生成し、`crypto_meta`（メタ）と
 * `key_envelopes`（kind='keyfile'）へ封筒を保存する。既にあれば封筒を KEK で開いて
 * DEK を復元する（KEK 違いは AEAD 認証失敗で throw）。
 *
 * 既存の平文データがある DB に対して初めて暗号を有効化した場合は、
 * {@link migratePlaintextToEncrypted} で全行をその場で暗号化する（新規 DB では no-op）。
 *
 * Phase 6 の正式なアンロックは {@link import("./unlock.ts").unlockOrSetup} に移った。
 * 本関数はキーファイルのみのセットアップ／アンロックを 1 呼び出しで行う薄い経路で、
 * 既存テスト（at-rest / migrate / init）と Phase 5 互換のために維持する。
 *
 * migrate（テーブル作成）後・データアクセス前に 1 回呼ぶこと。
 */
export async function initCrypto(db: Db, kek: Uint8Array): Promise<CryptoContext> {
  await ready();

  if (await hasEnvelope(db, "keyfile")) {
    const dek = await unlockWithKeyfile(db, kek);
    return provisionCrypto(db, dek);
  }

  const dek = generateDek();
  // メタ行（version / created_at）。Phase 6 では封筒の正本ではないが、後方互換と
  // バージョン管理のため crypto_meta も書く（wrapped_dek は key_envelopes と同一封筒）。
  const [meta] = await db.select().from(cryptoMeta).where(eq(cryptoMeta.id, 1)).limit(1);
  if (meta === undefined) {
    await db.insert(cryptoMeta).values({
      id: 1,
      version: ENVELOPE_VERSION,
      wrappedDek: Buffer.from(wrapDek(dek, kek)),
      kekSalt: null,
      createdAt: new Date().toISOString(),
    });
  }
  await addKeyfileEnvelope(db, dek, kek);
  const ctx = provisionCrypto(db, dek);
  // 既存の平文データ（暗号 OFF で書かれた行）があればその場で暗号化する。
  // 新規 DB なら全テーブル空で no-op。
  await migratePlaintextToEncrypted(db, ctx);
  return ctx;
}

/**
 * 平文のまま書かれた既存行を、その場で暗号化する（1 トランザクション）。
 *
 * 初めて暗号を有効化したときに 1 回だけ呼ぶ。対象は entries(raw/converted)、
 * chunks(content)、tags(name + name_fingerprint)、embeddings(vector + content_hash)。
 * 暗号 ON の書き込み形式と同一にするため、`ctx` のヘルパーで暗号化し直す。
 */
export async function migratePlaintextToEncrypted(db: Db, ctx: CryptoContext): Promise<void> {
  await db.transaction(async (tx) => {
    for (const row of await tx.select().from(entries)) {
      await tx
        .update(entries)
        .set({
          raw: ctx.encString(row.raw, "entry.raw"),
          converted: ctx.encString(row.converted, "entry.converted"),
        })
        .where(eq(entries.id, row.id));
    }

    // embeddings.content_hash を新方式（鍵付き）へ移すには平文 content が要るので、
    // chunk を暗号化する前に chunkId → 平文 content を控えておく。
    const plaintextByChunk = new Map<number, string>();
    for (const row of await tx.select().from(chunks)) {
      plaintextByChunk.set(row.id, row.content);
      await tx
        .update(chunks)
        .set({ content: ctx.encString(row.content, "chunk.content") })
        .where(eq(chunks.id, row.id));
    }

    for (const row of await tx.select().from(tags)) {
      await tx
        .update(tags)
        .set({
          name: ctx.encString(row.name, "tag.name"),
          nameFingerprint: ctx.fingerprint(row.name),
        })
        .where(eq(tags.id, row.id));
    }

    for (const row of await tx.select().from(embeddings)) {
      const vec = new Float32Array(
        row.vector.buffer,
        row.vector.byteOffset,
        row.vector.byteLength / 4,
      );
      const plaintext = plaintextByChunk.get(row.chunkId);
      await tx
        .update(embeddings)
        .set({
          vector: Buffer.from(ctx.encVector(vec, "embedding.vector")),
          // 平文が分かれば新ハッシュへ。分からなければ温存し、暗号 ON 初回の
          // syncChunkEmbeddings が差分検知して張り替える。
          contentHash: plaintext === undefined ? row.contentHash : ctx.contentHash(plaintext),
        })
        .where(eq(embeddings.chunkId, row.chunkId));
    }
  });
}
