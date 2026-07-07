import { beforeEach, describe, expect, test } from "bun:test";
import { createDb } from "@zakki/data/db/connect.ts";
import { handlePull, handlePush } from "@zakki/web/server/replication/handlers.ts";
import type { ReplicationStore } from "@zakki/web/server/replication/store.ts";
import { createReplicationStore } from "@zakki/web/server/replication/store.ts";
import { wire } from "@zakki/web/server/replication/test-fixtures.ts";

/**
 * issue #42: store × protocol の合成（handlePull / handlePush）。
 * libSQL の実 store に対して checkpoint 反復・tombstone・楽観ロック衝突を検証する。
 */
let store: ReplicationStore;

beforeEach(async () => {
  const db = await createDb(":memory:");
  store = createReplicationStore(db);
});

describe("handlePull", () => {
  test("B1: checkpoint 反復で差分のみ返る（null → 全件、追いつき後は以後の write のみ）", async () => {
    const a = wire("a", "2026-07-07T00:00:01Z");
    const b = wire("b", "2026-07-07T00:00:02Z");
    (await store.write("chunks", a))._unsafeUnwrap();
    (await store.write("chunks", b))._unsafeUnwrap();

    const first = (await handlePull(store, "chunks", null, 100))._unsafeUnwrap();
    expect(first.documents).toEqual([a, b]);
    expect(first.checkpoint).toEqual({ id: "b", updatedAt: "2026-07-07T00:00:02Z" });

    // 追いついた: 同じ checkpoint での再 pull は空・checkpoint 据え置き
    const caughtUp = (await handlePull(store, "chunks", first.checkpoint, 100))._unsafeUnwrap();
    expect(caughtUp.documents).toEqual([]);
    expect(caughtUp.checkpoint).toEqual(first.checkpoint);

    // 以後の write だけが流れる
    const c = wire("c", "2026-07-07T00:00:03Z");
    (await store.write("chunks", c))._unsafeUnwrap();
    const diff = (await handlePull(store, "chunks", first.checkpoint, 100))._unsafeUnwrap();
    expect(diff.documents).toEqual([c]);
    expect(diff.checkpoint).toEqual({ id: "c", updatedAt: "2026-07-07T00:00:03Z" });
  });

  test("B2: tombstone（_deleted: true）も pull に流れる", async () => {
    const gone = wire("a", "2026-07-07T00:00:01Z", { _deleted: true });
    (await store.write("chunks", gone))._unsafeUnwrap();
    const r = (await handlePull(store, "chunks", null, 100))._unsafeUnwrap();
    expect(r.documents).toEqual([gone]);
  });
});

describe("handlePush", () => {
  test("B3: 新規 push（assumedMasterState=null・master 無し）は書き込まれ conflicts は空", async () => {
    const next = wire("a", "2026-07-07T00:00:01Z");
    const conflicts = (
      await handlePush(store, "chunks", [{ assumedMasterState: null, newDocumentState: next }])
    )._unsafeUnwrap();
    expect(conflicts).toEqual([]);
    expect((await store.getById("chunks", "a"))._unsafeUnwrap()).toEqual(next);
  });

  test("B4: 衝突時（assumed ≠ current）は master を conflict として返し、上書きしない", async () => {
    const master = wire("a", "2026-07-07T00:00:09Z", { content: "enc:master" });
    (await store.write("chunks", master))._unsafeUnwrap();

    const stale = wire("a", "2026-07-07T00:00:05Z", { content: "enc:stale" });
    const next = wire("a", "2026-07-07T00:00:10Z", { content: "enc:next" });
    const conflicts = (
      await handlePush(store, "chunks", [{ assumedMasterState: stale, newDocumentState: next }])
    )._unsafeUnwrap();
    expect(conflicts).toEqual([master]);
    // master は上書きされていない
    expect((await store.getById("chunks", "a"))._unsafeUnwrap()).toEqual(master);
  });
});
