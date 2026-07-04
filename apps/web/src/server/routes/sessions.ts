import { Hono } from "hono";
import * as v from "valibot";
import { localDate, saveSessionEntry } from "@zakki/data/entry/autosave.ts";
import { getSessionEntryWithChunks } from "@zakki/data/entry/repository.ts";
import {
  createSession,
  deleteSession,
  getOrCreateDefaultSession,
  listSessions,
  renameSession,
  setSessionTags,
} from "@zakki/data/session/repository.ts";
import type { AppDeps } from "@zakki/web/server/deps.ts";
import { intParam, parseBody } from "@zakki/web/server/parse.ts";
import { respond } from "@zakki/web/server/respond.ts";

const CreateSessionSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  date: v.optional(v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/))),
});
const DefaultSessionSchema = v.object({
  date: v.optional(v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/))),
});
const RenameSchema = v.object({ name: v.pipe(v.string(), v.minLength(1)) });
const TagsSchema = v.object({ names: v.array(v.string()) });
const SaveEntrySchema = v.object({ raw: v.string(), converted: v.string() });

export function sessionRoutes(deps: AppDeps): Hono {
  const { db, analysis } = deps;
  const app = new Hono();

  app.get("/", (c) => respond(c, listSessions(db)));

  app.post("/", async (c) => {
    const body = await parseBody(c.req.raw, CreateSessionSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    return respond(c, createSession(db, { name: body.name, date: body.date ?? localDate() }));
  });

  // 当日（または指定日）のデフォルトセッションを取得・なければ作成する（クライアントの起点）
  app.post("/default", async (c) => {
    const body = await parseBody(c.req.raw, DefaultSessionSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    return respond(c, getOrCreateDefaultSession(db, body.date ?? localDate()));
  });

  app.patch("/:id", async (c) => {
    const id = intParam(c, "id");
    const body = await parseBody(c.req.raw, RenameSchema);
    if (id === null || body === null) return c.json({ error: "invalid request" }, 400);
    return respond(
      c,
      renameSession(db, id, body.name).map(() => ({ ok: true })),
    );
  });

  app.delete("/:id", (c) => {
    const id = intParam(c, "id");
    if (id === null) return c.json({ error: "invalid id" }, 400);
    return respond(
      c,
      deleteSession(db, id).map(() => ({ ok: true })),
    );
  });

  app.put("/:id/tags", async (c) => {
    const id = intParam(c, "id");
    const body = await parseBody(c.req.raw, TagsSchema);
    if (id === null || body === null) return c.json({ error: "invalid request" }, 400);
    return respond(
      c,
      setSessionTags(db, id, body.names).map(() => ({ ok: true })),
    );
  });

  app.get("/:id/entry", (c) => {
    const id = intParam(c, "id");
    if (id === null) return c.json({ error: "invalid id" }, 400);
    return respond(
      c,
      getSessionEntryWithChunks(db, id).map((saved) => ({
        entry: saved?.entry ?? null,
        chunks: saved?.chunks ?? [],
      })),
    );
  });

  // 保存（クライアント側 300ms デバウンス想定）。成功したら解析を予約する
  app.put("/:id/entry", async (c) => {
    const id = intParam(c, "id");
    const body = await parseBody(c.req.raw, SaveEntrySchema);
    if (id === null || body === null) return c.json({ error: "invalid request" }, 400);
    return saveSessionEntry(db, id, body).match(
      (saved) => {
        if (saved === null) return c.json({ error: `セッションが存在しません: id=${id}` }, 404);
        analysis.schedule();
        return c.json({ entry: saved.entry, chunks: saved.chunks });
      },
      (e) => c.json({ error: e.message }, 500),
    );
  });

  return app;
}
