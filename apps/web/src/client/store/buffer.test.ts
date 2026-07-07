import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildRaw } from "@zakki/core/entry/records.ts";
import { localDate } from "@zakki/core/util/local-date.ts";
import type { ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { openTestDb } from "@zakki/web/client/db/test-db.ts";
import { docId, numId } from "@zakki/web/client/db/ids.ts";
import { getOrCreateDateChunkDoc, saveChildrenDocs } from "@zakki/web/client/db/writes.ts";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

/**
 * issue #44: buffer store の RxDB 移行。GET /api/chunks/date・GET /api/chunks/:id を
 * 廃し、ローカル RxDB（リロード時は IndexedDB レプリカ）からバッファを復元する。
 */
let dbs: ZakkiDatabase[] = [];
async function open(): Promise<ZakkiDatabase> {
  const db = await openTestDb();
  dbs.push(db);
  return db;
}

beforeEach(() => {
  useBufferStore.setState({
    db: null,
    current: null,
    initialRaw: null,
    initialChunkIds: [],
    related: [],
    error: null,
  });
  useGraphStore.setState({ drillId: null, selectedNodeId: null });
});

afterEach(async () => {
  await Promise.all(dbs.map((db) => db.remove()));
  dbs = [];
});

const T1 = "2026-07-07T00:00:01.000Z";

describe("useBufferStore", () => {
  test("openToday: 日付チャンクを作成してバッファに開き、グラフをドリルする", async () => {
    const db = await open();
    useBufferStore.getState().connect(db);
    await useBufferStore.getState().openToday();

    const today = localDate();
    const state = useBufferStore.getState();
    expect(state.current?.date).toBe(today);
    expect(state.initialRaw).toBe("");
    expect(state.initialChunkIds).toEqual([]);
    expect(state.error).toBeNull();
    expect(useGraphStore.getState().drillId).toBe(state.current?.id ?? null);
    expect(await db.chunks.findOne({ selector: { date: today } }).exec()).not.toBeNull();
  });

  test("openChunk: 子チャンクから initialRaw / initialChunkIds を再構成する", async () => {
    const db = await open();
    useBufferStore.getState().connect(db);
    const parent = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    const children = await saveChildrenDocs(
      db,
      parent.id,
      [{ content: "一" }, { content: "二" }],
      T1,
    );

    await useBufferStore.getState().openChunk(numId(parent.id));
    const state = useBufferStore.getState();
    expect(state.current?.id).toBe(numId(parent.id));
    expect(state.initialRaw).toBe(buildRaw(["一", "二"]));
    expect(state.initialChunkIds).toEqual(children.map((c) => numId(c.id)));
  });

  test("openChunk: 存在しない id はエラー表示になる", async () => {
    const db = await open();
    useBufferStore.getState().connect(db);
    await useBufferStore.getState().openChunk(999);
    expect(useBufferStore.getState().error).toContain("999");
  });

  test("docId round-trip: 大きなクライアント採番 id でも開ける", async () => {
    const db = await open();
    useBufferStore.getState().connect(db);
    const parent = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    const children = await saveChildrenDocs(db, parent.id, [{ content: "深い" }], T1);
    const childId = numId(children[0]?.id ?? "");
    await useBufferStore.getState().openChunk(childId);
    expect(useBufferStore.getState().current?.id).toBe(childId);
    expect(docId(childId)).toBe(children[0]?.id ?? "");
  });
});
