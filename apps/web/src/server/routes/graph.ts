import { Hono } from "hono";
import { okAsync } from "neverthrow";
import { getSessionEntryWithChunks } from "@zakki/data/entry/repository.ts";
import type { RelatedChunk } from "@zakki/data/embedding/semantic.ts";
import { relatedChunks } from "@zakki/data/embedding/semantic.ts";
import { getGraph } from "@zakki/data/graph/queries.ts";
import type { AppDeps } from "@zakki/web/server/deps.ts";
import { intParam } from "@zakki/web/server/parse.ts";
import { respond } from "@zakki/web/server/respond.ts";

const RELATED_LIMIT = 5;

export function graphRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const app = new Hono();

  app.get("/graph", (c) => respond(c, getGraph(db)));

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
