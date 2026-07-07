import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildRaw } from "@zakki/core/entry/records.ts";
import { localDate } from "@zakki/core/util/local-date.ts";
import type { ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { openTestDb } from "@zakki/web/client/db/test-db.ts";
import { docId, numId } from "@zakki/web/client/db/ids.ts";
import { getOrCreateDateChunkDoc, saveChildrenDocs } from "@zakki/web/client/db/writes.ts";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";

/**
 * issue #44: buffer store の RxDB 移行。GET /api/chunks/date・GET /api/chunks/:id を
 * 廃し、ローカル RxDB（リロード時は IndexedDB レプリカ）からバッファを復元する。
 * どのチャンクを開くかは URL が SSOT（#52）: openToday / openChunk は router の
 * controller が呼び、グラフ store への手動同期は無い（ドリル位置は URL から導出）。
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
    currentId: null,
    initialRaw: null,
    initialChunkIds: [],
    error: null,
  });
});

afterEach(async () => {
  await Promise.all(dbs.map((db) => db.remove()));
  dbs = [];
});

const T1 = "2026-07-07T00:00:01.000Z";

describe("useBufferStore", () => {
  test("openToday: 日付チャンクを作成してバッファに開く", async () => {
    const db = await open();
    useBufferStore.getState().connect(db);
    await useBufferStore.getState().openToday();

    const today = localDate();
    const state = useBufferStore.getState();
    const doc = await db.chunks.findOne({ selector: { date: today } }).exec();
    expect(doc).not.toBeNull();
    expect(state.currentId).toBe(numId(doc?.id ?? ""));
    expect(state.initialRaw).toBe("");
    expect(state.initialChunkIds).toEqual([]);
    expect(state.error).toBeNull();
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
    expect(state.currentId).toBe(numId(parent.id));
    expect(state.initialRaw).toBe(buildRaw(["一", "二"]));
    expect(state.initialChunkIds).toEqual(children.map((c) => numId(c.id)));
  });

  test("openChunk: 存在しない id はエラー表示になる", async () => {
    const db = await open();
    useBufferStore.getState().connect(db);
    await useBufferStore.getState().openChunk(999);
    expect(useBufferStore.getState().error).toContain("999");
  });

  test("連打ナビ: A→B の連続要求は応答順によらず B（最後の要求）が勝つ", async () => {
    const db = await open();
    useBufferStore.getState().connect(db);
    const a = await getOrCreateDateChunkDoc(db, "2026-07-06", T1);
    const b = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);

    const first = useBufferStore.getState().openChunk(numId(a.id));
    const second = useBufferStore.getState().openChunk(numId(b.id));
    await Promise.all([first, second]);
    expect(useBufferStore.getState().currentId).toBe(numId(b.id));
  });

  test("連打ナビ: 旧要求の応答が後着しても新要求の状態を上書きしない（世代トークン）", async () => {
    const db = await open();
    useBufferStore.getState().connect(db);
    const a = await getOrCreateDateChunkDoc(db, "2026-07-06", T1);

    // A（正常・await 2 回で遅い）→ 999（存在せず・await 1 回で速い）を連続要求。
    // 世代トークンが無いと A の後着応答が currentId / error を巻き戻す
    const first = useBufferStore.getState().openChunk(numId(a.id));
    const second = useBufferStore.getState().openChunk(999);
    await Promise.all([first, second]);
    const state = useBufferStore.getState();
    expect(state.error).toContain("999");
    expect(state.currentId).toBeNull();
  });

  test("docId round-trip: 大きなクライアント採番 id でも開ける", async () => {
    const db = await open();
    useBufferStore.getState().connect(db);
    const parent = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    const children = await saveChildrenDocs(db, parent.id, [{ content: "深い" }], T1);
    const childId = numId(children[0]?.id ?? "");
    await useBufferStore.getState().openChunk(childId);
    expect(useBufferStore.getState().currentId).toBe(childId);
    expect(docId(childId)).toBe(children[0]?.id ?? "");
  });
});
