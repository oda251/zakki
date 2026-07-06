import { beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import type { IndexDelta, IndexedChunk } from "@zakki/web/client/store/plaintext-index.ts";
import { openPlaintextIndex } from "@zakki/web/client/store/plaintext-index.ts";

/**
 * クライアント平文インデックス（IndexedDB ストア本体）のテスト。
 * bun は IndexedDB を持たないため fake-indexeddb を使う。`beforeEach` で毎回新しい
 * `IDBFactory` を global へ張り直す: (1) テスト間を空の DB で分離し、(2) 同一プロセスで
 * 走る opentui の testRender（`apps/tui` 側）が `globalThis.indexedDB` を消す汚染を
 * 打ち消す。各テストは一意の DB 名でも分離する。
 */
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

const chunk = (over: Partial<IndexedChunk> & { id: number }): IndexedChunk => ({
  parentId: 1,
  position: 0,
  content: "本文",
  date: null,
  polarity: null,
  updatedAt: "2026-07-06T00:00:00.000Z",
  ...over,
});

describe("plaintext-index", () => {
  test("openPlaintextIndex は所定の object store 一式を作る", async () => {
    const idx = await openPlaintextIndex("t-schema");
    const cmp = (a: string, b: string) => a.localeCompare(b);
    expect([...idx.db.objectStoreNames].toSorted(cmp)).toEqual(
      ["chunk_user_tags", "chunks", "corrections", "meta", "tags"].toSorted(cmp),
    );
    idx.close();
  });

  test("同名 DB を開き直しても格納済みレコードが保持される", async () => {
    const a = await openPlaintextIndex("t-persist");
    await a.putChunk(chunk({ id: 7, content: "残る" }));
    a.close();
    const b = await openPlaintextIndex("t-persist");
    expect(await b.getChunk(7)).toEqual(chunk({ id: 7, content: "残る" }));
    b.close();
  });

  test("putChunk 後の getChunk は同じレコードを返す", async () => {
    const idx = await openPlaintextIndex("t-chunk-roundtrip");
    const c = chunk({ id: 3, content: "やあ", polarity: 0.5 });
    await idx.putChunk(c);
    expect(await idx.getChunk(3)).toEqual(c);
    idx.close();
  });

  test("未登録 id の getChunk は undefined", async () => {
    const idx = await openPlaintextIndex("t-chunk-missing");
    expect(await idx.getChunk(999)).toBeUndefined();
    idx.close();
  });

  test("getChildren は当該 parentId のチャンクを position 昇順で返す", async () => {
    const idx = await openPlaintextIndex("t-children");
    await idx.putChunk(chunk({ id: 10, parentId: 100, position: 2, content: "c" }));
    await idx.putChunk(chunk({ id: 11, parentId: 100, position: 0, content: "a" }));
    await idx.putChunk(chunk({ id: 12, parentId: 100, position: 1, content: "b" }));
    await idx.putChunk(chunk({ id: 13, parentId: 200, position: 0, content: "別親" }));
    const kids = await idx.getChildren(100);
    expect(kids.map((k) => k.content)).toEqual(["a", "b", "c"]);
    idx.close();
  });

  test("getAllChunks は全チャンクを返す", async () => {
    const idx = await openPlaintextIndex("t-all");
    await idx.putChunk(chunk({ id: 1 }));
    await idx.putChunk(chunk({ id: 2 }));
    expect((await idx.getAllChunks()).map((c) => c.id).toSorted((a, b) => a - b)).toEqual([1, 2]);
    idx.close();
  });

  test("deleteChunk 後、その getChunk は undefined", async () => {
    const idx = await openPlaintextIndex("t-chunk-delete");
    await idx.putChunk(chunk({ id: 5 }));
    await idx.deleteChunk(5);
    expect(await idx.getChunk(5)).toBeUndefined();
    idx.close();
  });

  test("putUserTag 後の getUserTagsByChunk は当該チャンクのタグを返す", async () => {
    const idx = await openPlaintextIndex("t-usertag");
    await idx.putUserTag({ id: 1, chunkId: 42, name: "日記" });
    await idx.putUserTag({ id: 2, chunkId: 42, name: "旅行" });
    await idx.putUserTag({ id: 3, chunkId: 99, name: "別" });
    const tags = await idx.getUserTagsByChunk(42);
    expect(tags.map((t) => t.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "旅行",
      "日記",
    ]);
    idx.close();
  });

  test("deleteUserTag でそのタグが消える", async () => {
    const idx = await openPlaintextIndex("t-usertag-delete");
    await idx.putUserTag({ id: 1, chunkId: 42, name: "日記" });
    await idx.deleteUserTag(1);
    expect(await idx.getUserTagsByChunk(42)).toEqual([]);
    idx.close();
  });

  test("putTag / getTag が round-trip し deleteTag で消える", async () => {
    const idx = await openPlaintextIndex("t-tag");
    await idx.putTag({ id: 8, name: "自動タグ" });
    expect(await idx.getTag(8)).toEqual({ id: 8, name: "自動タグ" });
    await idx.deleteTag(8);
    expect(await idx.getTag(8)).toBeUndefined();
    idx.close();
  });

  test("putCorrection 後の getCorrections は Map<kana, chosen> を返す", async () => {
    const idx = await openPlaintextIndex("t-corrections");
    await idx.putCorrection({
      kana: "きろく",
      chosen: "記録",
      updatedAt: "2026-07-06T00:00:00.000Z",
    });
    await idx.putCorrection({
      kana: "かんじ",
      chosen: "漢字",
      updatedAt: "2026-07-06T00:00:00.000Z",
    });
    const map = await idx.getCorrections();
    expect(map).toBeInstanceOf(Map);
    expect(map.get("きろく")).toBe("記録");
    expect(map.get("かんじ")).toBe("漢字");
    idx.close();
  });

  test("初期 getCursor は undefined、setCursor 後はその値を返す", async () => {
    const idx = await openPlaintextIndex("t-cursor");
    expect(await idx.getCursor()).toBeUndefined();
    await idx.setCursor("2026-07-06T12:00:00.000Z");
    expect(await idx.getCursor()).toBe("2026-07-06T12:00:00.000Z");
    idx.close();
  });

  test("applyDelta は 1 回で全ストアへ upsert を反映する", async () => {
    const idx = await openPlaintextIndex("t-delta-upsert");
    await idx.applyDelta({
      chunks: { upsert: [chunk({ id: 1, parentId: 50, content: "本文" })] },
      userTags: { upsert: [{ id: 1, chunkId: 1, name: "日記" }] },
      tags: { upsert: [{ id: 1, name: "自動" }] },
      corrections: {
        upsert: [{ kana: "きろく", chosen: "記録", updatedAt: "2026-07-06T00:00:00.000Z" }],
      },
    });
    expect((await idx.getChunk(1))?.content).toBe("本文");
    expect((await idx.getUserTagsByChunk(1)).map((t) => t.name)).toEqual(["日記"]);
    expect(await idx.getTag(1)).toEqual({ id: 1, name: "自動" });
    expect((await idx.getCorrections()).get("きろく")).toBe("記録");
    idx.close();
  });

  test("applyDelta の delete 指定が全ストアへ反映される", async () => {
    const idx = await openPlaintextIndex("t-delta-delete");
    await idx.applyDelta({
      chunks: { upsert: [chunk({ id: 1 })] },
      userTags: { upsert: [{ id: 1, chunkId: 1, name: "日記" }] },
      tags: { upsert: [{ id: 1, name: "自動" }] },
      corrections: {
        upsert: [{ kana: "きろく", chosen: "記録", updatedAt: "2026-07-06T00:00:00.000Z" }],
      },
    });
    await idx.applyDelta({
      chunks: { delete: [1] },
      userTags: { delete: [1] },
      tags: { delete: [1] },
      corrections: { delete: ["きろく"] },
    });
    expect(await idx.getChunk(1)).toBeUndefined();
    expect(await idx.getUserTagsByChunk(1)).toEqual([]);
    expect(await idx.getTag(1)).toBeUndefined();
    expect((await idx.getCorrections()).size).toBe(0);
    idx.close();
  });

  test("applyDelta に cursor を渡すとカーソルが前進する", async () => {
    const idx = await openPlaintextIndex("t-delta-cursor");
    await idx.applyDelta({ cursor: "2026-07-06T10:00:00.000Z" });
    expect(await idx.getCursor()).toBe("2026-07-06T10:00:00.000Z");
    idx.close();
  });

  test("applyDelta は冪等: 同じ delta を 2 回適用しても重複しない", async () => {
    const idx = await openPlaintextIndex("t-delta-idempotent");
    const delta: IndexDelta = {
      chunks: { upsert: [chunk({ id: 1 }), chunk({ id: 2 })] },
      corrections: {
        upsert: [{ kana: "きろく", chosen: "記録", updatedAt: "2026-07-06T00:00:00.000Z" }],
      },
    };
    await idx.applyDelta(delta);
    await idx.applyDelta(delta);
    expect((await idx.getAllChunks()).length).toBe(2);
    expect((await idx.getCorrections()).size).toBe(1);
    idx.close();
  });
});
