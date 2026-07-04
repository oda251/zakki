import { Hono } from "hono";
import { ResultAsync } from "neverthrow";
import * as v from "valibot";
import { loadConversionCache, saveConversion } from "@zakki/data/conversion/cache.ts";
import { loadCorrections, saveCorrection } from "@zakki/data/conversion/corrections.ts";
import type { AppDeps } from "@zakki/web/server/deps.ts";
import { parseBody } from "@zakki/web/server/parse.ts";
import { respond } from "@zakki/web/server/respond.ts";

const ConvertSchema = v.object({
  kana: v.pipe(v.string(), v.minLength(1)),
  leftContext: v.optional(v.string()),
});
const SaveConversionSchema = v.object({ kana: v.string(), converted: v.string() });
const SaveCorrectionSchema = v.object({ kana: v.string(), chosen: v.string() });

export function conversionRoutes(deps: AppDeps): Hono {
  const { db, engine } = deps;
  const app = new Hono();

  // かな → 変換候補（良い順）。Composer.Web の RemoteEngine が叩く
  app.post("/convert", async (c) => {
    const body = await parseBody(c.req.raw, ConvertSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    return respond(
      c,
      engine.convert(body.kana, body.leftContext).map((candidates) => ({ candidates })),
    );
  });

  // ConversionPipeline のシード（corrections 優先・cache は自動変換の再利用）
  app.get("/conversion/state", (c) =>
    respond(
      c,
      ResultAsync.combine([loadCorrections(db), loadConversionCache(db)]).map(
        ([corrections, cache]) => ({
          corrections: Object.fromEntries(corrections),
          cache: Object.fromEntries(cache),
        }),
      ),
    ),
  );

  app.post("/conversion/cache", async (c) => {
    const body = await parseBody(c.req.raw, SaveConversionSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    return respond(
      c,
      saveConversion(db, body.kana, body.converted).map(() => ({ ok: true })),
    );
  });

  app.post("/conversion/corrections", async (c) => {
    const body = await parseBody(c.req.raw, SaveCorrectionSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    return respond(
      c,
      saveCorrection(db, body.kana, body.chosen).map(() => ({ ok: true })),
    );
  });

  return app;
}
