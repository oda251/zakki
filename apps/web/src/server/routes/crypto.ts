import { Hono } from "hono";
import { errAsync } from "neverthrow";
import { DEK_BYTES } from "@zakki/core/crypto/dek.ts";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import {
  deletePasskeyEnvelope,
  putPasskeyEnvelopeIfProvisioned,
} from "@zakki/data/crypto/envelopes.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import type { KeyEnvelope } from "@zakki/data/db/schema.ts";
import { keyEnvelopes } from "@zakki/data/db/schema.ts";
import type { AppDeps } from "@zakki/web/server/deps.ts";
import { dbForRequest } from "@zakki/web/server/deps.ts";
import { parseBody } from "@zakki/web/server/parse.ts";
import { respond } from "@zakki/web/server/respond.ts";
import type { CryptoEnvelope } from "@zakki/web/shared/api-schemas.ts";
import { PasskeyEnvelopePutSchema } from "@zakki/web/shared/api-schemas.ts";

/**
 * クライアントアンロック用の封筒配布（issue #43）と passkey 封筒の登録・失効
 * （issue #103 / #120）。
 *
 * 配布（GET）の wire 形は #120 でも変わらない: 既に「封筒の配列 + kind の
 * discriminated union」なので、passkey 封筒が複数入るだけで済む。
 *
 * 封筒（wrapped DEK / salt / KDF パラメータ / credentialId）は KEK 無しには開けない
 * 公開可能情報で、この経路に平文 DEK・PRF 出力・復号は一切置かない（#28。
 * アンロックはクライアント側の `client/db/unlock.ts` が行う）。keyfile 封筒は
 * サーバ端末ローカルの KEK 専用（`packages/data/src/crypto/keyfile.ts`）なので
 * wire には出さない。
 */

/** drizzle blob（Buffer）→ base64（ORIGINAL。クライアント from_base64 と対） */
function b64(buf: Buffer): string {
  return sodium.to_base64(
    new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    sodium.base64_variants.ORIGINAL,
  );
}

/**
 * keyfile 封筒・メタ欠落行（KDF パラメータ / credentialId）は配布対象外（null）。
 * passkey の credentialId 欠落は schema の CHECK 制約で入り得ないが、開けない封筒を
 * クライアントへ配らないための最後の砦として残す。
 */
function toWireEnvelope(row: KeyEnvelope): CryptoEnvelope | null {
  if (row.kind === "keyfile") return null;
  if (row.kind === "passkey") {
    if (row.credentialId === null) return null;
    return {
      kind: row.kind,
      wrappedDek: b64(row.wrappedDek),
      credentialId: row.credentialId,
    };
  }
  if (row.kdfSalt === null || row.kdfOps === null || row.kdfMem === null) return null;
  return {
    kind: row.kind,
    wrappedDek: b64(row.wrappedDek),
    kdfSalt: b64(row.kdfSalt),
    kdfOps: row.kdfOps,
    kdfMem: row.kdfMem,
  };
}

export function cryptoRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/envelopes", async (c) => {
    // base64 変換に sodium を使うため wasm 初期化を待つ（多重呼び出しは安全・即時解決）
    await ready();
    // 封筒はユーザ自身の DB の中にある（#105 のマルチユーザ構成では中継先ごとに別）
    const db = await dbForRequest(deps, c.req.raw);
    if (db === null) return c.json({ error: "認証が必要です" }, 401);
    return respond(
      c,
      tryDbAsync(() => db.select().from(keyEnvelopes)).map((rows) => ({
        envelopes: rows.map(toWireEnvelope).filter((e) => e !== null),
      })),
    );
  });

  // passkey 封筒の登録（issue #103 / #120）。クライアントで wrap 済みの封筒を保存する
  // だけで、平文 DEK・PRF 出力はこの経路に現れない。封筒は **credentialId 単位** で、
  // 同じ credentialId の再登録だけが上書きになる（別のパスキーは別の封筒として増える）。
  app.post("/envelopes/passkey", async (c) => {
    const body = await parseBody(c.req.raw, PasskeyEnvelopePutSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    await ready();
    const db = await dbForRequest(deps, c.req.raw);
    if (db === null) return c.json({ error: "認証が必要です" }, 401);
    let wrappedDek: Uint8Array;
    try {
      wrappedDek = sodium.from_base64(body.wrappedDek, sodium.base64_variants.ORIGINAL);
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    // 封筒は `nonce || ciphertext`（aead.ts encrypt）で長さが一意に決まる:
    // XChaCha20 nonce 24B + DEK 32B + Poly1305 tag 16B = 72B。それ以外は wrap 済み
    // DEK 封筒ではあり得ないので保存前に拒否する（開けない封筒を作らせない）。
    const wrappedDekBytes =
      sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES +
      DEK_BYTES +
      sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;
    if (wrappedDek.length !== wrappedDekBytes) return c.json({ error: "invalid body" }, 400);
    // 暗号未プロビジョン（封筒ゼロ）の DB へは登録させない（409）。passkey 封筒だけが
    // 存在すると unlockOrSetup の初回判定（kinds.length === 0）が壊れ、PRF を評価できない
    // TUI/CLI から復旧不能になる。既存封筒 1 つ以上（= DEK が確立済み）を事前条件にする。
    // 件数を読んでから書くと read-then-write の競合になるため、事前条件は SQL 側の
    // 条件（INSERT ... WHERE EXISTS）で表現する（#120）。
    const stored = await tryDbAsync(() =>
      putPasskeyEnvelopeIfProvisioned(db, wrappedDek, body.credentialId),
    );
    if (stored.isErr()) return respond(c, errAsync(stored.error));
    if (!stored.value) return c.json({ error: "crypto not provisioned" }, 409);
    return c.json({ ok: true });
  });

  // passkey 封筒の失効（issue #120）。パスキー自体（公開鍵）はコントロールプレーン DB に
  // あり、ここでは触れない: 失効は「クレデンシャル（apps/api の DELETE /auth/credentials/:id,
  // #115）」と「封筒（この経路）」の **2 つの DB に跨る** ため、両方を消すのはクライアントの
  // 責務になる。片方だけ成功しても致命的ではない（クレデンシャルを失効させれば PRF を
  // 評価できないので、残った封筒を開く経路が無い）。
  // 存在しない credentialId でも 200（冪等。2 段階削除の再実行を失敗させない）。
  app.delete("/envelopes/passkey/:credentialId", async (c) => {
    const credentialId = c.req.param("credentialId");
    if (credentialId === "") return c.json({ error: "invalid credentialId" }, 400);
    const db = await dbForRequest(deps, c.req.raw);
    if (db === null) return c.json({ error: "認証が必要です" }, 401);
    return respond(
      c,
      tryDbAsync(() => deletePasskeyEnvelope(db, credentialId)).map((deleted) => ({
        ok: true,
        deleted,
      })),
    );
  });

  return app;
}
