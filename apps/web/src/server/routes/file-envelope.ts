import { Hono } from "hono";
import { toBase64, fromBase64, WRAPPED_DEK_BYTES } from "@zakki/core/crypto/wire.ts";
import { getFileKeyEnvelope, putFileKeyEnvelope } from "@zakki/data/file/envelope.ts";
import type { AppDeps } from "@zakki/web/server/deps.ts";
import { dbForRequest } from "@zakki/web/server/deps.ts";
import { parseBody } from "@zakki/web/server/parse.ts";
import { respond } from "@zakki/web/server/respond.ts";
import type { FileEnvelope } from "@zakki/web/shared/api-schemas.ts";
import { FileEnvelopeSchema } from "@zakki/web/shared/api-schemas.ts";

/**
 * ファイル暗号鍵（FEK）の封筒の配布・保存（issue #157）。
 *
 * チャンクの DEK 封筒（`crypto.ts` の /api/crypto/envelopes）と**鍵とテーブルが別**:
 * FEK は添付ファイル専用で、DEK のローテーションに巻き込まれない。役割は同じ
 * 「封筒を右から左へ渡すだけで、サーバは unwrap できない」（#28。
 * depcruise `web-server-no-decrypt-capability`）。パスワード由来 KEK の導出と開封は
 * すべてクライアント側（`client/files/password.ts`）で行う。
 *
 * FEK は単一（封筒 1 本）なので、chunks の DEK 封筒と違って id=1 の 1 行を
 * GET / PUT で直読み・上書きするだけの素直な api にする。
 */

/** Argon2id の推奨ソルト長（`crypto_pwhash_SALTBYTES` = 16 バイト, kdf.ts の generateSalt） */
const KDF_SALT_BYTES = 16;

export function fileEnvelopeRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/file-envelope", async (c) => {
    const db = await dbForRequest(deps, c.req.raw);
    if (db === null) return c.json({ error: "認証が必要です" }, 401);
    return respond(
      c,
      getFileKeyEnvelope(db).map((envelope) => ({
        envelope:
          envelope === null
            ? null
            : ({
                wrappedFek: toBase64(envelope.wrappedFek),
                kdfSalt: toBase64(envelope.kdfSalt),
                kdfOps: envelope.kdfOps,
                kdfMem: envelope.kdfMem,
              } satisfies FileEnvelope),
      })),
    );
  });

  app.put("/file-envelope", async (c) => {
    const body = await parseBody(c.req.raw, FileEnvelopeSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    const db = await dbForRequest(deps, c.req.raw);
    if (db === null) return c.json({ error: "認証が必要です" }, 401);
    // 封筒は `nonce || ciphertext`（file-key.ts の wrapFek）で長さが一意に決まる:
    // XChaCha20 nonce 24B + FEK 32B + Poly1305 tag 16B = 72B。ソルトは Argon2id の
    // 16B。どちらも違えば「開けない封筒」が DB に入る経路なので保存前に拒否する
    // （crypto.ts の wrappedDek 検査と同じ流儀）。
    let wrappedFek: Uint8Array;
    let kdfSalt: Uint8Array;
    try {
      wrappedFek = fromBase64(body.wrappedFek);
      kdfSalt = fromBase64(body.kdfSalt);
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    if (wrappedFek.length !== WRAPPED_DEK_BYTES || kdfSalt.length !== KDF_SALT_BYTES) {
      return c.json({ error: "invalid body" }, 400);
    }
    return respond(
      c,
      putFileKeyEnvelope(db, {
        wrappedFek,
        kdfSalt,
        kdfOps: body.kdfOps,
        kdfMem: body.kdfMem,
      }).map(() => ({ ok: true })),
    );
  });

  return app;
}