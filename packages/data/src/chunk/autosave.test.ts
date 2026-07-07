import { beforeEach, describe, expect, test } from "bun:test";
import { wrapPaste } from "@zakki/core/conversion/paste.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { getOrCreateDateChunk, listChildren } from "./repository.ts";
import { localDate } from "@zakki/core/util/local-date.ts";
import { persistChildren } from "./autosave.ts";

let db: Db;

beforeEach(async () => {
  db = await createDb(":memory:");
});

describe("persistChildren", () => {
  test("converted を Enter 区切りでチャンク化して子へ投影する（マーカーは strip）", async () => {
    const root = (await getOrCreateDateChunk(db, "2026-07-06"))._unsafeUnwrap();
    const converted = `${wrapPaste("一。")}\n${wrapPaste("二。")}\nライブ行`;
    const saved = (await persistChildren(db, root.id, converted))._unsafeUnwrap();
    expect(saved?.map((c) => c.content)).toEqual(["一。", "二。", "ライブ行"]);
    const children = (await listChildren(db, root.id))._unsafeUnwrap();
    expect(children.map((c) => c.content)).toEqual(["一。", "二。", "ライブ行"]);
  });

  test("キーストローク単位で呼ばれても冪等（id 安定）", async () => {
    const root = (await getOrCreateDateChunk(db, "2026-07-06"))._unsafeUnwrap();
    const first = (await persistChildren(db, root.id, "一。\n"))._unsafeUnwrap();
    const second = (await persistChildren(db, root.id, "一。\n"))._unsafeUnwrap();
    expect(second?.map((c) => c.id)).toEqual(first?.map((c) => c.id) ?? []);
  });

  test("親チャンクが無ければ null（Err ではない）", async () => {
    const saved = (await persistChildren(db, 999, "一。"))._unsafeUnwrap();
    expect(saved).toBeNull();
  });
});

describe("localDate", () => {
  test("YYYY-MM-DD 形式", () => {
    expect(localDate(new Date(2026, 6, 6))).toBe("2026-07-06");
  });
});
