import { Hono } from "hono";
import { okAsync } from "neverthrow";
import { localDate } from "@zakki/core/util/local-date.ts";
import { persistChildren } from "@zakki/data/chunk/autosave.ts";
import {
  deleteChunk,
  getChunk,
  getOrCreateDateChunk,
  listChildren,
  updateChunkContent,
} from "@zakki/data/chunk/repository.ts";
import { setChunkUserTags } from "@zakki/data/chunk/user-tags.ts";
import type { RelatedChunk } from "@zakki/data/embedding/semantic.ts";
import { relatedChunks } from "@zakki/data/embedding/semantic.ts";
import type { AppDeps } from "@zakki/web/server/deps.ts";
import { intParam, parseBody } from "@zakki/web/server/parse.ts";
import { respond } from "@zakki/web/server/respond.ts";
import {
  DateChunkSchema,
  RenameSchema,
  SaveChildrenSchema,
  TagsSchema,
} from "@zakki/web/shared/api-schemas.ts";

const RELATED_LIMIT = 5;

/**
 * chunk ツリーの API（docs/CHUNKS.md）。旧 /sessions ルートの置き換え。
 * コンテナの新規作成に専用エンドポイントは無い: 親バッファへ行を追記して保存する
 * （PUT /:id/children）ことが作成であり、投影の position 空間と衝突しない。
 */
export function chunkRoutes(deps: AppDeps): Hono {
  const { db, analysis } = deps;
  const app = new Hono();

  // 当日（または指定日）の日付チャンクを取得・なければ作成する（クライアントの起点）
  app.post("/date", async (c) => {
    const body = await parseBody(c.req.raw, DateChunkSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    return respond(c, getOrCreateDateChunk(db, body.date ?? localDate()));
  });

  // バッファ読み出し: チャンク本体 + 子チャンク列（クライアントは raw を再構成する）
  app.get("/:id", async (c) => {
    const id = intParam(c, "id");
    if (id === null) return c.json({ error: "invalid id" }, 400);
    const result = await getChunk(db, id).andThen((chunk) =>
      chunk === null
        ? okAsync(null)
        : listChildren(db, id).map((children) => ({ chunk, children })),
    );
    return result.match(
      (payload) =>
        payload === null
          ? c.json({ error: `チャンクが存在しません: id=${id}` }, 404)
          : c.json(payload),
      (e) => c.json({ error: e.message }, 500),
    );
  });

  // バッファ保存（クライアント側 300ms デバウンス想定）。成功したら解析を予約する
  app.put("/:id/children", async (c) => {
    const id = intParam(c, "id");
    const body = await parseBody(c.req.raw, SaveChildrenSchema);
    if (id === null || body === null) return c.json({ error: "invalid request" }, 400);
    return persistChildren(db, id, body.converted).match(
      (children) => {
        if (children === null) {
          return c.json({ error: `チャンクが存在しません: id=${id}` }, 404);
        }
        analysis.schedule();
        return c.json({ children });
      },
      (e) => c.json({ error: e.message }, 500),
    );
  });

  // 本文（コンテナ名）の変更。親バッファを開いていない文脈からのリネーム用
  app.patch("/:id", async (c) => {
    const id = intParam(c, "id");
    const body = await parseBody(c.req.raw, RenameSchema);
    if (id === null || body === null) return c.json({ error: "invalid request" }, 400);
    return respond(
      c,
      updateChunkContent(db, id, body.content).map(() => ({ ok: true })),
    );
  });

  app.delete("/:id", (c) => {
    const id = intParam(c, "id");
    if (id === null) return c.json({ error: "invalid id" }, 400);
    return respond(
      c,
      deleteChunk(db, id).map(() => ({ ok: true })),
    );
  });

  app.put("/:id/tags", async (c) => {
    const id = intParam(c, "id");
    const body = await parseBody(c.req.raw, TagsSchema);
    if (id === null || body === null) return c.json({ error: "invalid request" }, 400);
    return respond(
      c,
      setChunkUserTags(db, id, body.names).map(() => ({ ok: true })),
    );
  });

  // 末尾の子チャンク（子が無ければ自身）の意味的近傍（TUI の関連アンビエントと共有）
  app.get("/:id/related", (c) => {
    const id = intParam(c, "id");
    if (id === null) return c.json({ error: "invalid id" }, 400);
    return respond(
      c,
      listChildren(db, id)
        .andThen((children) => {
          const target = children.at(-1)?.id ?? id;
          return relatedChunks(db, target, RELATED_LIMIT);
        })
        .orElse(() => okAsync<RelatedChunk[]>([]))
        .map((items) => ({ items })),
    );
  });

  return app;
}
