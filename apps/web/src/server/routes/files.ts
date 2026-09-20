import { Hono } from "hono";
import { DEFAULT_PART_BYTES, MAX_PART_BYTES } from "@zakki/core/file/upload.ts";
import { objectKeyFor } from "@zakki/web/server/files/store.ts";
import type { AppDeps } from "@zakki/web/server/deps.ts";
import { userForRequest } from "@zakki/web/server/deps.ts";
import { parseBody } from "@zakki/web/server/parse.ts";
import { FileMultipartCompleteSchema } from "@zakki/web/shared/api-schemas.ts";

/**
 * ファイル実体（バイト列）の中継（issue #157）。
 *
 * サーバは multipart の組み立て・完了・読み出し・削除を R2 へ仲介するだけで、
 * 暗号化・復号には一切関与しない（クライアントが暗号化済みのバイト列を送る。
 * #28 の不変条件 / depcruise `web-server-no-decrypt-capability`）。
 *
 * オブジェクトキーは `accounts/<accountId>/<fileId>`（store.ts の objectKeyFor）。
 * accountId は中継先の解決（{@link userForRequest}）が返す値で、fileId はクライアント
 * 生成のパスセグメント。どちらもパス区切り・親参照を混入できないよう objectKeyFor
 * が検査し、細工した fileId で他アカウントのキーを踏もうとする経路を塞ぐ（D7）。
 *
 * R2 multipart が無い配備（単一ユーザ self-host, deps.files 未指定）は 503 を返す。
 */

export function fileRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/:fileId/multipart", async (c) => {
    if (deps.files === undefined) return c.json({ error: "ファイル保管は利用できません" }, 503);
    const user = await userForRequest(deps, c.req.raw);
    if (user === null) return c.json({ error: "認証が必要です" }, 401);
    const key = keyFor(user.accountId, c.req.param("fileId"));
    if (key === null) return c.json({ error: "invalid fileId" }, 400);
    const created = await deps.files.createMultipart(key);
    // objectKey も返す: クライアントはこの値を files doc に保存するだけで、
    // アカウント名前空間（objectKeyFor の規約）を知る必要がない
    return c.json({
      uploadId: created.uploadId,
      partSize: deps.partSize ?? DEFAULT_PART_BYTES,
      objectKey: key,
    });
  });

  app.put("/:fileId/multipart/:uploadId/parts/:n", async (c) => {
    if (deps.files === undefined) return c.json({ error: "ファイル保管は利用できません" }, 503);
    const user = await userForRequest(deps, c.req.raw);
    if (user === null) return c.json({ error: "認証が必要です" }, 401);
    const key = keyFor(user.accountId, c.req.param("fileId"));
    if (key === null) return c.json({ error: "invalid fileId" }, 400);
    const partNumber = Number(c.req.param("n"));
    if (!Number.isInteger(partNumber) || partNumber < 1) {
      return c.json({ error: "invalid part number" }, 400);
    }
    const body = await c.req.arrayBuffer();
    if (body.byteLength > MAX_PART_BYTES) {
      return c.json({ error: "part が上限を超えています" }, 413);
    }
    const uploaded = await deps.files.uploadPart(key, c.req.param("uploadId"), partNumber, body);
    return c.json({ etag: uploaded.etag });
  });

  app.post("/:fileId/multipart/:uploadId/complete", async (c) => {
    if (deps.files === undefined) return c.json({ error: "ファイル保管は利用できません" }, 503);
    const user = await userForRequest(deps, c.req.raw);
    if (user === null) return c.json({ error: "認証が必要です" }, 401);
    const key = keyFor(user.accountId, c.req.param("fileId"));
    if (key === null) return c.json({ error: "invalid fileId" }, 400);
    const body = await parseBody(c.req.raw, FileMultipartCompleteSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    await deps.files.completeMultipart(key, c.req.param("uploadId"), body.parts);
    return c.json({ ok: true });
  });

  app.get("/:fileId", async (c) => {
    if (deps.files === undefined) return c.json({ error: "ファイル保管は利用できません" }, 503);
    const user = await userForRequest(deps, c.req.raw);
    if (user === null) return c.json({ error: "認証が必要です" }, 401);
    const key = keyFor(user.accountId, c.req.param("fileId"));
    if (key === null) return c.json({ error: "invalid fileId" }, 400);
    const bytes = await deps.files.get(key);
    if (bytes === null) return c.json({ error: "not found" }, 404);
    return new Response(Uint8Array.from(bytes), { status: 200 });
  });

  app.delete("/:fileId", async (c) => {
    if (deps.files === undefined) return c.json({ error: "ファイル保管は利用できません" }, 503);
    const user = await userForRequest(deps, c.req.raw);
    if (user === null) return c.json({ error: "認証が必要です" }, 401);
    const key = keyFor(user.accountId, c.req.param("fileId"));
    if (key === null) return c.json({ error: "invalid fileId" }, 400);
    await deps.files.delete(key);
    return c.json({ ok: true });
  });

  return app;
}

/**
 * accountId + fileId からオブジェクトキーを組み立てる。
 * パスセグメント検査（store.ts の objectKeyFor）に失敗したら null → 400。
 */
function keyFor(accountId: string, fileId: string): string | null {
  try {
    return objectKeyFor(accountId, fileId);
  } catch {
    return null;
  }
}