import { beforeEach, describe, expect, test } from "bun:test";
import { createDb } from "@zakki/data/db/connect.ts";
import type { ReplicationStore, WireDoc } from "@zakki/web/server/replication/store.ts";
import { createReplicationStore } from "@zakki/web/server/replication/store.ts";

/**
 * issue #42: ReplicationStore の libSQL 実装。
 * 汎用テーブル repl_docs(collection, id, updated_at, deleted, data) に
 * wire doc（暗号文 JSON）を domain schema 非依存で読み書きする dumb store。
 */
let store: ReplicationStore;

beforeEach(async () => {
  const db = await createDb(":memory:");
  store = createReplicationStore(db);
});

/** wire doc のダミー。content は暗号文 base64 の想定（サーバは中身を解釈しない） */
const wire = (id: string, updatedAt: string, over: Record<string, unknown> = {}): WireDoc => ({
  id,
  updatedAt,
  _deleted: false,
  content: `enc:${id}`,
  ...over,
});

describe("ReplicationStore (libSQL)", () => {
  test("A1: write → getById で wire doc（任意フィールド込み）が往復する。未知 id は undefined", async () => {
    const doc = wire("a", "2026-07-07T00:00:01Z", { polarity: 0.5, parentId: null });
    (await store.write("chunks", doc))._unsafeUnwrap();
    expect((await store.getById("chunks", "a"))._unsafeUnwrap()).toEqual(doc);
    expect((await store.getById("chunks", "missing"))._unsafeUnwrap()).toBeUndefined();
  });

  test("A2: 同一 (collection, id) への write は上書き（upsert）", async () => {
    (await store.write("chunks", wire("a", "2026-07-07T00:00:01Z")))._unsafeUnwrap();
    const next = wire("a", "2026-07-07T00:00:02Z", { _deleted: true });
    (await store.write("chunks", next))._unsafeUnwrap();
    expect((await store.getById("chunks", "a"))._unsafeUnwrap()).toEqual(next);
    expect((await store.listAll("chunks"))._unsafeUnwrap()).toHaveLength(1);
  });

  test("A3: listAll は当該 collection の doc のみ返す（他 collection と分離）", async () => {
    const chunk = wire("a", "2026-07-07T00:00:01Z");
    const tag = wire("a", "2026-07-07T00:00:02Z", { name: "enc:tag" });
    (await store.write("chunks", chunk))._unsafeUnwrap();
    (await store.write("tags", tag))._unsafeUnwrap();
    expect((await store.listAll("chunks"))._unsafeUnwrap()).toEqual([chunk]);
    expect((await store.listAll("tags"))._unsafeUnwrap()).toEqual([tag]);
  });
});
