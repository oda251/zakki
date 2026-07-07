import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { errAsync, okAsync } from "neverthrow";
import { respond } from "./respond.ts";

describe("respond", () => {
  test("Ok は 200 で値をそのまま返す", async () => {
    const app = new Hono().get("/ok", (c) => respond(c, okAsync({ value: 42 })));
    const res = await app.request("/ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 42 });
  });

  test("Err は 500 で、内部メッセージを wire に漏らさない（issue #58 項目 4）", async () => {
    const internal = "SQLITE_ERROR: no such table: /home/user/.local/share/zakki.sqlite";
    const app = new Hono().get("/err", (c) =>
      respond(c, errAsync({ type: "db-error", message: internal, cause: undefined })),
    );
    const res = await app.request("/err");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("サーバ内部エラー");
    expect(JSON.stringify(body)).not.toContain("SQLITE_ERROR");
  });
});
