import { Hono } from "hono";
import { okAsync } from "neverthrow";
import * as v from "valibot";
import { getSessionEntryWithChunks } from "@zakki/data/entry/repository.ts";
import type { RelatedChunk } from "@zakki/data/embedding/semantic.ts";
import { relatedChunks } from "@zakki/data/embedding/semantic.ts";
import { getGraph } from "@zakki/data/graph/queries.ts";
import { addManualLink } from "@zakki/data/link/repository.ts";
import type { AppDeps } from "@zakki/web/server/deps.ts";
import { intParam, parseBody } from "@zakki/web/server/parse.ts";
import { respond } from "@zakki/web/server/respond.ts";

const RELATED_LIMIT = 5;

const LinkSchema = v.object({
  from: v.pipe(v.number(), v.integer()),
  to: v.pipe(v.number(), v.integer()),
});

export function graphRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const app = new Hono();

  app.get("/graph", (c) => respond(c, getGraph(db)));

  // 手動リンク（web の数珠繋ぎ自動リンクが叩く）。from<to 正規化・重複 no-op は data 層
  app.post("/links", async (c) => {
    const body = await parseBody(c.req.raw, LinkSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    return respond(
      c,
      addManualLink(db, body.from, body.to).map(() => ({ ok: true })),
    );
  });

  // セッション末尾チャンクの意味的近傍（TUI の関連アンビエントと同じ relatedChunks を共有）
  app.get("/sessions/:id/related", (c) => {
    const id = intParam(c, "id");
    if (id === null) return c.json({ error: "invalid id" }, 400);
    return respond(
      c,
      getSessionEntryWithChunks(db, id)
        .andThen((saved) => {
          const last = saved?.chunks.at(-1);
          return last === undefined
            ? okAsync([] as RelatedChunk[])
            : relatedChunks(db, last.id, RELATED_LIMIT);
        })
        .map((items) => ({ items })),
    );
  });

  return app;
}
