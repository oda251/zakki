import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { addRxPlugin } from "rxdb";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import type { ChunkDoc, ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { createZakkiDb } from "@zakki/web/client/db/database.ts";
import { childrenQuery, correctionsMap } from "@zakki/web/client/db/docs.ts";

/**
 * RxDB Phase 1（#40）。memory storage + dev-mode + ajv バリデータで検証する
 * （IndexedDB 不要 = opentui のグローバル汚染を受けない）。primaryKey は string。
 */
beforeAll(() => {
  addRxPlugin(RxDBDevModePlugin);
});

const testStorage = () => wrappedValidateAjvStorage({ storage: getRxStorageMemory() });

const chunk = (over: Partial<ChunkDoc> & { id: string }): ChunkDoc => ({
  parentId: "0",
  position: 0,
  content: "本文",
  date: null,
  polarity: null,
  updatedAt: "2026-07-06T00:00:00.000Z",
  ...over,
});

let dbs: ZakkiDatabase[] = [];
async function open(): Promise<ZakkiDatabase> {
  const db = await createZakkiDb(testStorage());
  dbs.push(db);
  return db;
}
afterEach(async () => {
  await Promise.all(dbs.map((db) => db.remove()));
  dbs = [];
});

const tick = () => new Promise((r) => setTimeout(r, 30));

describe("rxdb database (Phase 1)", () => {
  test("createZakkiDb は 4 コレクションを持つ", async () => {
    const db = await open();
    expect(Object.keys(db.collections).toSorted()).toEqual(
      ["chunkUserTags", "chunks", "corrections", "tags"].toSorted(),
    );
  });

  test("chunks に SSOT 形（id string）を insert → findOne で往復する", async () => {
    const db = await open();
    await db.chunks.insert(chunk({ id: "3", content: "やあ", polarity: 0.5 }));
    const doc = await db.chunks.findOne("3").exec();
    expect(doc?.toJSON()).toMatchObject(chunk({ id: "3", content: "やあ", polarity: 0.5 }));
  });

  test("childrenQuery は当該 parentId の子を position 昇順で返す", async () => {
    const db = await open();
    await db.chunks.bulkInsert([
      chunk({ id: "10", parentId: "100", position: 2, content: "c" }),
      chunk({ id: "11", parentId: "100", position: 0, content: "a" }),
      chunk({ id: "12", parentId: "100", position: 1, content: "b" }),
      chunk({ id: "13", parentId: "200", position: 0, content: "別親" }),
    ]);
    const kids = await childrenQuery(db, "100");
    expect(kids.map((k) => k.content)).toEqual(["a", "b", "c"]);
  });

  test("correctionsMap は kana→chosen の Map を返す", async () => {
    const db = await open();
    await db.corrections.bulkInsert([
      { kana: "きろく", chosen: "記録", updatedAt: "2026-07-06T00:00:00.000Z" },
      { kana: "かんじ", chosen: "漢字", updatedAt: "2026-07-06T00:00:00.000Z" },
    ]);
    const map = await correctionsMap(db);
    expect(map.get("きろく")).toBe("記録");
    expect(map.get("かんじ")).toBe("漢字");
  });

  test("reactive: find().$ は insert 後に再度 emit する", async () => {
    const db = await open();
    const seen: number[] = [];
    const sub = db.chunks.find().$.subscribe((docs) => seen.push(docs.length));
    await tick();
    await db.chunks.insert(chunk({ id: "1" }));
    await tick();
    sub.unsubscribe();
    expect(seen.at(0)).toBe(0);
    expect(seen.at(-1)).toBe(1);
  });

  test("ソフト削除: remove 後 find はその行を含まない", async () => {
    const db = await open();
    await db.chunks.insert(chunk({ id: "5" }));
    const doc = await db.chunks.findOne("5").exec();
    await doc?.remove();
    const remaining = await db.chunks.find().exec();
    expect(remaining.map((d) => d.id)).not.toContain("5");
  });
});
