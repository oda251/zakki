import { Hono } from "hono";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import type { KeyEnvelope } from "@zakki/data/db/schema.ts";
import { keyEnvelopes } from "@zakki/data/db/schema.ts";
import type { AppDeps } from "@zakki/web/server/deps.ts";
import { respond } from "@zakki/web/server/respond.ts";
import type { CryptoEnvelope } from "@zakki/web/shared/api-schemas.ts";

/**
 * クライアントアンロック用の封筒配布（issue #43）。
 *
 * 封筒（wrapped DEK / salt / KDF パラメータ）は KEK 無しには開けない公開可能情報で、
 * この経路に平文 DEK・復号は一切置かない（#28。アンロックはクライアント側の
 * `client/db/unlock.ts` が行う）。keyfile 封筒はサーバ端末ローカルの KEK 専用
 * （`packages/data/src/crypto/keyfile.ts`）なので wire には出さない。
 */

/** drizzle blob（Buffer）→ base64（ORIGINAL。クライアント from_base64 と対） */
function b64(buf: Buffer): string {
  return sodium.to_base64(
    new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    sodium.base64_variants.ORIGINAL,
  );
}

/** keyfile 封筒・KDF メタ欠落行は配布対象外（null） */
function toWireEnvelope(row: KeyEnvelope): CryptoEnvelope | null {
  if (row.kind === "keyfile") return null;
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

  return app;
}
