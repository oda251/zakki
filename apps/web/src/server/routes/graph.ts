import { Hono } from "hono";
import { ResultAsync } from "neverthrow";
import { getSessionEntryWithChunks } from "@zakki/data/entry/repository.ts";
import { listChunksWithDate } from "@zakki/data/entry/queries.ts";
import { loadVectors } from "@zakki/data/embedding/store.ts";
import { nearestChunks } from "@zakki/data/embedding/semantic.ts";
import { getGraph } from "@zakki/data/graph/queries.ts";
import type { RelatedChunk } from "@zakki/web/shared/api-types.ts";
import type { AppDeps } from "@zakki/web/server/deps.ts";
import { respond } from "@zakki/web/server/respond.ts";

const RELATED_LIMIT = 5;

export function graphRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const app = new Hono();

  app.get("/graph", (c) => respond(c, getGraph(db)));

  // セッション末尾チャンクの意味的近傍（TUI の refreshAmbient 相当, apps/tui/src/tui/App.tsx）
  app.get("/sessions/:id/related", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    return respond(
      c,
      ResultAsync.combine([
        getSessionEntryWithChunks(db, id),
        loadVectors(db),
        listChunksWithDate(db),
      ]).map(([saved, vectors, all]) => {
        const last = saved?.chunks.at(-1);
        const lastVector = last === undefined ? undefined : vectors.get(last.id);
        if (last === undefined || lastVector === undefined) {
          return { items: [] as RelatedChunk[] };
        }
        const byId = new Map(all.map((chunk) => [chunk.id, chunk]));
        const items = nearestChunks(vectors, lastVector, RELATED_LIMIT + 1)
          .filter((n) => n.chunkId !== last.id)
          .slice(0, RELATED_LIMIT)
          .flatMap((n) => {
            const chunk = byId.get(n.chunkId);
            return chunk === undefined
              ? []
              : [{ chunkId: chunk.id, date: chunk.date, content: chunk.content, score: n.score }];
          });
        return { items };
      }),
    );
  });

  return app;
}
