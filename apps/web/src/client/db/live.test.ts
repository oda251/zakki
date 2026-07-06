import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { firstValueFrom } from "rxjs";
import { addRxPlugin } from "rxdb";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import type { ChunkDoc, ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { createZakkiDb } from "@zakki/web/client/db/database.ts";
import { childrenView, correctionsView } from "@zakki/web/client/db/live.ts";

/**
 * Phase 4（#40）: RxDB を UI 購読用 Observable に変換する reactive view。
 * memory storage + dev-mode + ajv（IndexedDB 非依存 = opentui 汚染なし）。
 */
beforeAll(() => {
  addRxPlugin(RxDBDevModePlugin);
});

const chunk = (over: Partial<ChunkDoc> & { id: string }): ChunkDoc => ({
  parentId: "100",
  position: 0,
  content: "本文",
  date: null,
  polarity: null,
  updatedAt: "2026-07-06T00:00:00.000Z",
  ...over,
});

let dbs: ZakkiDatabase[] = [];
async function open(): Promise<ZakkiDatabase> {
  const db = await createZakkiDb(wrappedValidateAjvStorage({ storage: getRxStorageMemory() }));
  dbs.push(db);
  return db;
}
afterEach(async () => {
  await Promise.all(dbs.map((db) => db.remove()));
  dbs = [];
});

const tick = () => new Promise((r) => setTimeout(r, 30));

describe("reactive views (Phase 4)", () => {
  test("childrenView は購読時に現在の子を position 昇順で emit する", async () => {
    const db = await open();
    await db.chunks.bulkInsert([
      chunk({ id: "10", position: 2, content: "c" }),
      chunk({ id: "11", position: 0, content: "a" }),
      chunk({ id: "12", position: 1, content: "b" }),
    ]);
    const first = await firstValueFrom(childrenView(db, "100"));
    expect(first.map((c) => c.content)).toEqual(["a", "b", "c"]);
  });

  test("子を insert すると childrenView が並び順込みで再 emit する", async () => {
    const db = await open();
    await db.chunks.insert(chunk({ id: "11", position: 1, content: "a" }));
    const seen: string[][] = [];
    const sub = childrenView(db, "100").subscribe((docs) => seen.push(docs.map((c) => c.content)));
    await tick();
    await db.chunks.insert(chunk({ id: "10", position: 0, content: "new-head" }));
    await tick();
    sub.unsubscribe();
    expect(seen.at(0)).toEqual(["a"]);
    expect(seen.at(-1)).toEqual(["new-head", "a"]);
  });

  test("correctionsView は Map を emit し insert で再 emit する", async () => {
    const db = await open();
    await db.corrections.insert({
      kana: "きろく",
      chosen: "記録",
      updatedAt: "2026-07-06T00:00:00.000Z",
    });
    const seen: Array<Map<string, string>> = [];
    const sub = correctionsView(db).subscribe((m) => seen.push(m));
    await tick();
    await db.corrections.insert({
      kana: "かんじ",
      chosen: "漢字",
      updatedAt: "2026-07-06T00:00:00.000Z",
    });
    await tick();
    sub.unsubscribe();
    expect(seen.at(0)?.get("きろく")).toBe("記録");
    expect(seen.at(-1)?.get("かんじ")).toBe("漢字");
  });
});
