import { describe, expect, test } from "bun:test";
import type { Checkpoint } from "@zakki/web/server/replication/protocol.ts";
import { resolvePush, selectChanges } from "@zakki/web/server/replication/protocol.ts";

/**
 * Phase 3（#40）: RxDB replication サーバプロトコルの純ロジック。
 * サーバは暗号文を同期する dumb store（復号しない）。doc は id/updatedAt/_deleted を持つ。
 */
interface Doc {
  id: string;
  updatedAt: string;
  _deleted: boolean;
  v: number;
}
const doc = (id: string, updatedAt: string, over: Partial<Doc> = {}): Doc => ({
  id,
  updatedAt,
  _deleted: false,
  v: 0,
  ...over,
});

describe("replication protocol (Phase 3)", () => {
  test("selectChanges(null) は (updatedAt,id) 昇順で全件＋末尾 checkpoint", () => {
    const docs = [doc("b", "2026-07-06T00:00:02Z"), doc("a", "2026-07-06T00:00:01Z")];
    const r = selectChanges(docs, null, 100);
    expect(r.documents.map((d) => d.id)).toEqual(["a", "b"]);
    expect(r.checkpoint).toEqual({ id: "b", updatedAt: "2026-07-06T00:00:02Z" });
  });

  test("checkpoint 指定時は厳密に後の doc のみ返す", () => {
    const docs = [
      doc("a", "2026-07-06T00:00:01Z"),
      doc("b", "2026-07-06T00:00:02Z"),
      doc("c", "2026-07-06T00:00:03Z"),
    ];
    const cp: Checkpoint = { id: "b", updatedAt: "2026-07-06T00:00:02Z" };
    const r = selectChanges(docs, cp, 100);
    expect(r.documents.map((d) => d.id)).toEqual(["c"]);
  });

  test("追いついたら documents=[]・checkpoint は入力 cp をそのまま返す", () => {
    const docs = [doc("a", "2026-07-06T00:00:01Z")];
    const cp: Checkpoint = { id: "a", updatedAt: "2026-07-06T00:00:01Z" };
    const r = selectChanges(docs, cp, 100);
    expect(r.documents).toEqual([]);
    expect(r.checkpoint).toEqual(cp);
  });

  test("limit を尊重し先頭 N 件＋checkpoint=N 件目", () => {
    const docs = [
      doc("a", "2026-07-06T00:00:01Z"),
      doc("b", "2026-07-06T00:00:02Z"),
      doc("c", "2026-07-06T00:00:03Z"),
    ];
    const r = selectChanges(docs, null, 2);
    expect(r.documents.map((d) => d.id)).toEqual(["a", "b"]);
    expect(r.checkpoint).toEqual({ id: "b", updatedAt: "2026-07-06T00:00:02Z" });
  });

  test("_deleted（tombstone）の doc も含める", () => {
    const docs = [doc("a", "2026-07-06T00:00:01Z", { _deleted: true })];
    const r = selectChanges(docs, null, 100);
    // tombstone doc がそのまま（_deleted:true 込みで）pull に流れる
    expect(r.documents).toEqual(docs);
  });

  test("resolvePush: 新規（current 無し・assumed null）は write", () => {
    const next = doc("x", "2026-07-06T00:00:05Z");
    const r = resolvePush(undefined, { assumedMasterState: null, newDocumentState: next });
    expect(r.write).toEqual(next);
    expect(r.conflict).toBeNull();
  });

  test("resolvePush: 衝突（current.updatedAt ≠ assumed）は上書きせず conflict=current", () => {
    const current = doc("x", "2026-07-06T00:00:09Z", { v: 9 });
    const assumed = doc("x", "2026-07-06T00:00:05Z", { v: 5 });
    const next = doc("x", "2026-07-06T00:00:10Z", { v: 10 });
    const r = resolvePush(current, { assumedMasterState: assumed, newDocumentState: next });
    expect(r.write).toBeNull();
    expect(r.conflict).toEqual(current);
  });
});
