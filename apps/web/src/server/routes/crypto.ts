import { Hono } from "hono";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { putPasskeyEnvelope } from "@zakki/data/crypto/envelopes.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import type { KeyEnvelope } from "@zakki/data/db/schema.ts";
import { keyEnvelopes } from "@zakki/data/db/schema.ts";
import type { AppDeps } from "@zakki/web/server/deps.ts";
import { parseBody } from "@zakki/web/server/parse.ts";
import { respond } from "@zakki/web/server/respond.ts";
import type { CryptoEnvelope } from "@zakki/web/shared/api-schemas.ts";
import { PasskeyEnvelopePutSchema } from "@zakki/web/shared/api-schemas.ts";

/**
 * クライアントアンロック用の封筒配布（issue #43）と passkey 封筒の登録（issue #103）。
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

/** keyfile 封筒・メタ欠落行（KDF パラメータ / credentialId）は配布対象外（null） */
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
    return respond(
      c,
      tryDbAsync(() => deps.db.select().from(keyEnvelopes)).map((rows) => ({
        envelopes: rows.map(toWireEnvelope).filter((e) => e !== null),
      })),
    );
  });

  // passkey 封筒の登録（issue #103）。クライアントで wrap 済みの封筒を保存するだけで、
  // 平文 DEK・PRF 出力はこの経路に現れない。kind 主キーにより再登録は上書き（1 封筒）。
  app.post("/envelopes/passkey", async (c) => {
    const body = await parseBody(c.req.raw, PasskeyEnvelopePutSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    await ready();
    let wrappedDek: Uint8Array;
    try {
      wrappedDek = sodium.from_base64(body.wrappedDek, sodium.base64_variants.ORIGINAL);
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    return respond(
      c,
      tryDbAsync(() => putPasskeyEnvelope(deps.db, wrappedDek, body.credentialId)).map(() => ({
        ok: true,
      })),
    );
  });

  return app;
}
