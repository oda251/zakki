import { Hono } from "hono";
import type { AppDeps } from "@zakki/web/server/deps.ts";
import { parseBody } from "@zakki/web/server/parse.ts";
import { handlePull, handlePush } from "@zakki/web/server/replication/handlers.ts";
import { createReplicationStore } from "@zakki/web/server/replication/store.ts";
import { respond } from "@zakki/web/server/respond.ts";
import { ReplicationPullSchema, ReplicationPushSchema } from "@zakki/web/shared/api-schemas.ts";

/**
 * RxDB replication の HTTP endpoint（issue #42, app.test.ts の流儀）。
 * サーバは wire doc（暗号文 JSON）を ReplicationStore で中継するだけの dumb store で、
 * この経路に getCrypto / DEK 参照・復号は一切置かない（#28）。
 */
export function replicationRoutes(deps: AppDeps): Hono {
  const store = createReplicationStore(deps.db);
  const app = new Hono();

  app.post("/:collection/pull", async (c) => {
    const collection = c.req.param("collection");
    const body = await parseBody(c.req.raw, ReplicationPullSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    return respond(c, handlePull(store, collection, body.checkpoint, body.limit));
  });

  app.post("/:collection/push", async (c) => {
    const collection = c.req.param("collection");
    const body = await parseBody(c.req.raw, ReplicationPushSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    return respond(
      c,
      handlePush(store, collection, body.rows).map((conflicts) => ({ conflicts })),
    );
  });

  return app;
}
