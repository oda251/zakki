import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { addRxPlugin } from "rxdb";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import type { ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { createZakkiDb } from "@zakki/web/client/db/database.ts";
import { numId } from "@zakki/web/client/db/ids.ts";
import { getOrCreateDateChunkDoc, saveChildrenDocs } from "@zakki/web/client/db/writes.ts";
import { EMPTY_FILTER } from "@zakki/web/client/store/graph-core.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

/**
 * issue #44: graph store の liveQuery 配線。手動 fetch（GET /api/graph）を廃し、
 * RxDB 購読（chunksView + userTagsView）から GraphData を導出する。
 * 受け入れ基準「投稿直後にグラフへ即時反映」をここで担保する。
 */
beforeAll(() => {
  addRxPlugin(RxDBDevModePlugin);
});

let dbs: ZakkiDatabase[] = [];
let disconnects: (() => void)[] = [];

async function open(): Promise<ZakkiDatabase> {
  const db = await createZakkiDb(wrappedValidateAjvStorage({ storage: getRxStorageMemory() }));
  dbs.push(db);
  return db;
}

function connect(db: ZakkiDatabase): void {
  disconnects.push(useGraphStore.getState().connect(db));
}

beforeEach(() => {
  useGraphStore.setState({
    data: null,
    error: null,
    drillId: null,
    filter: EMPTY_FILTER,
    selectedNodeId: null,
  });
});

afterEach(async () => {
  for (const disconnect of disconnects) disconnect();
  disconnects = [];
  await Promise.all(dbs.map((db) => db.remove()));
  dbs = [];
});

const T1 = "2026-07-07T00:00:01.000Z";
const tick = () => new Promise((r) => setTimeout(r, 30));

describe("useGraphStore.connect", () => {
  test("doc の挿入が購読経由で即時に data.nodes へ反映される", async () => {
    const db = await open();
    connect(db);
    const parent = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    await tick();
    expect(useGraphStore.getState().data?.nodes.map((n) => n.id)).toEqual([numId(parent.id)]);

    const saved = await saveChildrenDocs(db, parent.id, [{ content: "投稿" }], T1);
    await tick();
    const nodes = useGraphStore.getState().data?.nodes ?? [];
    expect(nodes.map((n) => n.id).toSorted((a, b) => a - b)).toEqual(
      [numId(saved[0]?.id ?? ""), numId(parent.id)].toSorted((a, b) => a - b),
    );
    expect(nodes.find((n) => n.id === numId(parent.id))?.childCount).toBe(1);
  });

  test("手動エッジは doc 再 emit を跨いで生存し、消えたノードのエッジは落ちる", async () => {
    const db = await open();
    connect(db);
    const parent = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    const saved = await saveChildrenDocs(db, parent.id, [{ content: "a" }, { content: "b" }], T1);
    await tick();
    const [a, b] = [numId(saved[0]?.id ?? ""), numId(saved[1]?.id ?? "")];
    useGraphStore.getState().addManualEdges([{ from: a, to: b }]);
    expect(useGraphStore.getState().data?.edges.length).toBe(1);

    // 別チャンク追加による再 emit ではエッジは生存する
    await saveChildrenDocs(
      db,
      parent.id,
      [{ content: "a" }, { content: "b" }, { content: "c" }],
      T1,
    );
    await tick();
    expect(useGraphStore.getState().data?.edges.length).toBe(1);

    // b を削除するとエッジも落ちる
    await saveChildrenDocs(db, parent.id, [{ content: "a" }, { content: "c" }], T1);
    await tick();
    expect(useGraphStore.getState().data?.edges).toEqual([]);
  });
});
