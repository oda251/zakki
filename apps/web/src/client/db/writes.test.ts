import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { addRxPlugin } from "rxdb";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import type { ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { createZakkiDb } from "@zakki/web/client/db/database.ts";
import {
  getOrCreateDateChunkDoc,
  removeChunkTree,
  renameChunkDoc,
  saveChildrenDocs,
  setUserTagDocs,
  upsertCorrection,
} from "@zakki/web/client/db/writes.ts";

/**
 * issue #44: UI 書込みの RxDB 移行。サーバ PUT /chunks/:id/children の投影
 * （repository.saveChildren の content 突き合わせ・cascade 削除）と同じ意味論を
 * クライアント側で担う。memory storage + dev-mode + ajv（live.test.ts と同じ流儀）。
 */
beforeAll(() => {
  addRxPlugin(RxDBDevModePlugin);
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

const T1 = "2026-07-07T00:00:01.000Z";
const T2 = "2026-07-07T00:00:02.000Z";

async function allChunks(db: ZakkiDatabase) {
  return (await db.chunks.find().exec()).map((d) => d.toJSON());
}

describe("getOrCreateDateChunkDoc", () => {
  test("平文の日付チャンク（parentId null / content=date / position 0）を作成し、冪等", async () => {
    const db = await open();
    const first = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    expect(first.parentId).toBeNull();
    expect(first.position).toBe(0);
    expect(first.content).toBe("2026-07-07");
    expect(first.date).toBe("2026-07-07");

    const again = await getOrCreateDateChunkDoc(db, "2026-07-07", T2);
    expect(again.id).toBe(first.id);
    expect((await allChunks(db)).length).toBe(1);
  });
});

describe("saveChildrenDocs", () => {
  test("初回保存は position 0..n-1 で子を挿入する", async () => {
    const db = await open();
    const parent = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    const saved = await saveChildrenDocs(db, parent.id, [{ content: "a" }, { content: "b" }], T1);
    expect(saved.map((c) => c.content)).toEqual(["a", "b"]);
    expect(saved.map((c) => c.position)).toEqual([0, 1]);
    expect(saved.every((c) => c.parentId === parent.id)).toBe(true);
    expect(saved.every((c) => c.date === null && c.polarity === null)).toBe(true);
  });

  test("content 完全一致の行は並び替え・挿入をまたいで id を維持する", async () => {
    const db = await open();
    const parent = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    const first = await saveChildrenDocs(db, parent.id, [{ content: "a" }, { content: "b" }], T1);
    const second = await saveChildrenDocs(
      db,
      parent.id,
      [{ content: "b" }, { content: "a" }, { content: "c" }],
      T2,
    );
    expect(second[0]?.id).toBe(first[1]?.id ?? "");
    expect(second[1]?.id).toBe(first[0]?.id ?? "");
    expect(second[2]?.id).not.toBe(first[0]?.id ?? "");
    expect(second.map((c) => c.position)).toEqual([0, 1, 2]);
  });

  test("編集された行は position 順で余った既存 id を再利用する", async () => {
    const db = await open();
    const parent = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    const first = await saveChildrenDocs(db, parent.id, [{ content: "a" }, { content: "b" }], T1);
    const second = await saveChildrenDocs(db, parent.id, [{ content: "a" }, { content: "b2" }], T2);
    expect(second[1]?.id).toBe(first[1]?.id ?? "");
    expect(second[1]?.content).toBe("b2");
  });

  test("どの草稿にも対応しない既存行は子孫・userTags ごと削除される", async () => {
    const db = await open();
    const parent = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    const first = await saveChildrenDocs(db, parent.id, [{ content: "a" }, { content: "b" }], T1);
    const b = first[1];
    if (b === undefined) throw new Error("b が保存されていません");
    // b の下に孫とその userTag をぶら下げる
    const grandchild = await saveChildrenDocs(db, b.id, [{ content: "b の子" }], T1);
    await setUserTagDocs(db, grandchild[0]?.id ?? "", ["tag1"], T1);

    await saveChildrenDocs(db, parent.id, [{ content: "a" }], T2);
    const remaining = await allChunks(db);
    expect(remaining.map((c) => c.content).toSorted()).toEqual(["2026-07-07", "a"]);
    expect(await db.chunkUserTags.find().exec()).toEqual([]);
  });

  test("無変更の行は updatedAt を動かさない（replication ノイズ回避）", async () => {
    const db = await open();
    const parent = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    const first = await saveChildrenDocs(db, parent.id, [{ content: "a" }, { content: "b" }], T1);
    const second = await saveChildrenDocs(db, parent.id, [{ content: "a" }, { content: "b2" }], T2);
    expect(second[0]?.updatedAt).toBe(first[0]?.updatedAt ?? "");
    expect(second[1]?.updatedAt).toBe(T2);
  });
});

describe("renameChunkDoc", () => {
  test("content を更新し、日付チャンクは拒否する", async () => {
    const db = await open();
    const parent = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    const saved = await saveChildrenDocs(db, parent.id, [{ content: "旧名" }], T1);
    await renameChunkDoc(db, saved[0]?.id ?? "", "新名", T2);
    expect((await db.chunks.findOne(saved[0]?.id ?? "").exec())?.content).toBe("新名");

    expect(renameChunkDoc(db, parent.id, "書き換え", T2)).rejects.toThrow();
  });
});

describe("removeChunkTree", () => {
  test("子孫と userTags を連鎖削除し、兄弟は残す", async () => {
    const db = await open();
    const parent = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    const children = await saveChildrenDocs(
      db,
      parent.id,
      [{ content: "a" }, { content: "b" }],
      T1,
    );
    const a = children[0];
    if (a === undefined) throw new Error("a が保存されていません");
    const grandchild = await saveChildrenDocs(db, a.id, [{ content: "a の子" }], T1);
    await setUserTagDocs(db, a.id, ["on-a"], T1);
    await setUserTagDocs(db, grandchild[0]?.id ?? "", ["on-grandchild"], T1);

    await removeChunkTree(db, a.id);
    const remaining = await allChunks(db);
    expect(remaining.map((c) => c.content).toSorted()).toEqual(["2026-07-07", "b"]);
    expect(await db.chunkUserTags.find().exec()).toEqual([]);
  });
});

describe("setUserTagDocs", () => {
  test("名前の差分同期: 追加・削除し、残ったタグは doc を維持する", async () => {
    const db = await open();
    await setUserTagDocs(db, "10", ["x", "y"], T1);
    const before = (await db.chunkUserTags.find().exec()).map((d) => d.toJSON());
    await setUserTagDocs(db, "10", ["y", "z"], T2);
    const after = (await db.chunkUserTags.find().exec()).map((d) => d.toJSON());

    expect(after.map((t) => t.name).toSorted()).toEqual(["y", "z"]);
    const yBefore = before.find((t) => t.name === "y");
    const yAfter = after.find((t) => t.name === "y");
    expect(yAfter?.id).toBe(yBefore?.id ?? "");
  });

  test("別チャンクのタグには触れない", async () => {
    const db = await open();
    await setUserTagDocs(db, "10", ["x"], T1);
    await setUserTagDocs(db, "20", ["x"], T1);
    await setUserTagDocs(db, "10", [], T2);
    const rest = (await db.chunkUserTags.find().exec()).map((d) => d.toJSON());
    expect(rest.map((t) => t.chunkId)).toEqual(["20"]);
  });
});

describe("upsertCorrection", () => {
  test("kana キーで upsert する", async () => {
    const db = await open();
    await upsertCorrection(db, "きろく", "記録", T1);
    await upsertCorrection(db, "きろく", "起録", T2);
    const docs = await db.corrections.find().exec();
    expect(docs.length).toBe(1);
    expect(docs[0]?.chosen).toBe("起録");
  });
});
