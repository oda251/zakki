import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { identityEngine } from "@zakki/core/conversion/engine.ts";
import { ready } from "@zakki/core/crypto/sodium.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import { replDocs } from "@zakki/data/db/schema.ts";
import type { Hono } from "hono";
import type { FieldCrypto } from "@zakki/web/client/db/crypto.ts";
import { makeFieldCrypto } from "@zakki/web/client/db/crypto.ts";
import type { ChunkDocData, ChunkWire } from "@zakki/web/client/db/modifiers.ts";
import { chunkPull, chunkPush } from "@zakki/web/client/db/modifiers.ts";
import { createAnalysisScheduler } from "@zakki/web/server/analysis.ts";
import { createApp } from "@zakki/web/server/app.ts";
import { createAnalysisEvents } from "@zakki/web/server/events.ts";
import type { Checkpoint, PullResult } from "@zakki/web/server/replication/protocol.ts";
import type { WireDoc } from "@zakki/web/server/replication/store.ts";
import { wire } from "@zakki/web/server/replication/test-fixtures.ts";

/**
 * issue #42: RxDB replication の HTTP endpoint（app.test.ts の流儀）。
 * サーバは暗号文の dumb store であり、この経路に復号・DEK 参照は無い（#28）。
 */
let db: Db;
let app: Hono;

beforeEach(async () => {
  db = await createDb(":memory:");
  app = createApp({
    db,
    engine: identityEngine,
    embedder: null,
    analysis: createAnalysisScheduler(db, null, () => {}, 0),
    events: createAnalysisEvents(),
  });
});

async function json<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

function post(path: string, body: unknown): Request {
  return new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// rows は wire JSON としてそのまま送る（client の Wire 型と server の WireDoc の
// 結合をテストの型付けで作らないため unknown で受ける。実際の経路も JSON over HTTP）
const push = (
  collection: string,
  rows: { assumedMasterState: unknown; newDocumentState: unknown }[],
) => app.request(post(`/api/replication/${collection}/push`, { rows }));

const pull = (collection: string, checkpoint: Checkpoint | null, limit: number) =>
  app.request(post(`/api/replication/${collection}/pull`, { checkpoint, limit }));

describe("POST /api/replication/:collection/pull", () => {
  test("C1: {checkpoint|null, limit} → {documents, checkpoint}。返った checkpoint での再 pull は差分のみ", async () => {
    // 空 DB: documents なし・checkpoint は入力（null）のまま
    const empty = await json<PullResult<WireDoc>>(await pull("chunks", null, 100));
    expect(empty).toEqual({ documents: [], checkpoint: null });

    const a = wire("a", "2026-07-07T00:00:01Z");
    const b = wire("b", "2026-07-07T00:00:02Z");
    await json(
      await push("chunks", [
        { assumedMasterState: null, newDocumentState: a },
        { assumedMasterState: null, newDocumentState: b },
      ]),
    );

    const first = await json<PullResult<WireDoc>>(await pull("chunks", null, 100));
    expect(first.documents).toEqual([a, b]);
    expect(first.checkpoint).toEqual({ id: "b", updatedAt: "2026-07-07T00:00:02Z" });

    // 追いつき後は空。以後の push（tombstone 込み）だけが流れる
    const caughtUp = await json<PullResult<WireDoc>>(await pull("chunks", first.checkpoint, 100));
    expect(caughtUp.documents).toEqual([]);

    const gone = wire("a", "2026-07-07T00:00:03Z", { _deleted: true });
    await json(await push("chunks", [{ assumedMasterState: a, newDocumentState: gone }]));
    const diff = await json<PullResult<WireDoc>>(await pull("chunks", first.checkpoint, 100));
    expect(diff.documents).toEqual([gone]);
  });
});

describe("POST /api/replication/:collection/push", () => {
  test("C2: {rows} → {conflicts}。衝突時は master を返し上書きしない", async () => {
    const master = wire("a", "2026-07-07T00:00:09Z", { content: "enc:master" });
    const seeded = await json<{ conflicts: WireDoc[] }>(
      await push("chunks", [{ assumedMasterState: null, newDocumentState: master }]),
    );
    expect(seeded.conflicts).toEqual([]);

    const stale = wire("a", "2026-07-07T00:00:05Z", { content: "enc:stale" });
    const next = wire("a", "2026-07-07T00:00:10Z", { content: "enc:next" });
    const conflicted = await json<{ conflicts: WireDoc[] }>(
      await push("chunks", [{ assumedMasterState: stale, newDocumentState: next }]),
    );
    expect(conflicted.conflicts).toEqual([master]);

    // master は上書きされていない
    const after = await json<PullResult<WireDoc>>(await pull("chunks", null, 100));
    expect(after.documents).toEqual([master]);
  });

  test("C3: 不正 body は 400", async () => {
    // pull: checkpoint / limit の欠落・形不正
    expect((await app.request(post("/api/replication/chunks/pull", {}))).status).toBe(400);
    expect(
      (await app.request(post("/api/replication/chunks/pull", { checkpoint: null }))).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          post("/api/replication/chunks/pull", { checkpoint: { id: 1 }, limit: 10 }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await app.request(post("/api/replication/chunks/pull", { checkpoint: null, limit: "x" })))
        .status,
    ).toBe(400);
    // push: rows の欠落・wire doc の形不正
    expect((await app.request(post("/api/replication/chunks/push", {}))).status).toBe(400);
    expect(
      (
        await app.request(
          post("/api/replication/chunks/push", {
            rows: [{ assumedMasterState: null, newDocumentState: { id: "a" } }],
          }),
        )
      ).status,
    ).toBe(400);
  });
});

describe("サーバは平文を保持しない（#28）", () => {
  let fc: FieldCrypto;
  beforeAll(async () => {
    const s = await ready();
    fc = makeFieldCrypto(s.crypto_aead_xchacha20poly1305_ietf_keygen());
  });

  test("C4: クライアント modifier で暗号化した wire を push すると data 列は暗号文のみ・復号はクライアントでだけ可能", async () => {
    const doc: ChunkDocData = {
      id: "c1",
      parentId: null,
      position: 0,
      content: "秘密の本文",
      date: null,
      polarity: null,
      updatedAt: "2026-07-07T00:00:01Z",
      _deleted: false,
    };
    const encrypted = chunkPush(fc, doc);
    expect(encrypted.content).not.toBe(doc.content);

    await json(await push("chunks", [{ assumedMasterState: null, newDocumentState: encrypted }]));

    // サーバ側の生の data 列に平文が含まれない（暗号文 wire JSON がそのまま入っている）
    const rows = await db.select().from(replDocs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data ?? "").not.toContain("秘密の本文");
    expect(rows[0]?.data ?? "").toContain(encrypted.content);

    // pull した wire はクライアントの鍵でのみ元に戻る
    const pulled = await json<PullResult<ChunkWire>>(await pull("chunks", null, 100));
    const wireDoc = pulled.documents[0];
    if (wireDoc === undefined) throw new Error("pull 結果が空");
    expect(chunkPull(fc, wireDoc)).toEqual(doc);
  });
});
