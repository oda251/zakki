import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { sessions, sessionTags } from "@zakki/data/db/schema.ts";
import {
  getEntryWithChunks,
  getSessionEntryWithChunks,
  saveSnapshot,
} from "@zakki/data/entry/repository.ts";
import { initCrypto } from "@zakki/data/crypto/init.ts";
import {
  createSession,
  deleteSession,
  getOrCreateDefaultSession,
  listSessions,
  renameSession,
  setSessionTags,
} from "./repository.ts";

let db: Db;

beforeAll(async () => {
  await ready();
});

beforeEach(async () => {
  db = await createDb(":memory:");
});

describe("getOrCreateDefaultSession", () => {
  test("なければ作成し、あれば同じものを返す（冪等）", async () => {
    const first = (await getOrCreateDefaultSession(db, "2026-07-05"))._unsafeUnwrap();
    const second = (await getOrCreateDefaultSession(db, "2026-07-05"))._unsafeUnwrap();
    expect(second.id).toBe(first.id);
    expect(first.name).toBeNull();
    expect(first.date).toBe("2026-07-05");
  });

  test("日付ごとに独立", async () => {
    const a = (await getOrCreateDefaultSession(db, "2026-07-04"))._unsafeUnwrap();
    const b = (await getOrCreateDefaultSession(db, "2026-07-05"))._unsafeUnwrap();
    expect(a.id).not.toBe(b.id);
  });
});

describe("createSession", () => {
  test("同日に名前付きセッションを複数持てる（デフォルトとも共存）", async () => {
    const date = "2026-07-05";
    (await getOrCreateDefaultSession(db, date))._unsafeUnwrap();
    const a = (await createSession(db, { name: "調査", date }))._unsafeUnwrap();
    const b = (await createSession(db, { name: "設計", date }))._unsafeUnwrap();
    expect(a.name).toBe("調査");
    expect(b.name).toBe("設計");
    const all = (await listSessions(db))._unsafeUnwrap();
    expect(all).toHaveLength(3);
  });

  test("空の名前は拒否する", async () => {
    const result = await createSession(db, { name: "  ", date: "2026-07-05" });
    expect(result.isErr()).toBe(true);
  });
});

describe("saveSnapshot のセッション対応", () => {
  test("sessionId 省略時はデフォルトセッションへ保存（従来挙動）", async () => {
    const saved = (
      await saveSnapshot(db, {
        date: "2026-07-05",
        raw: "a",
        converted: "あ",
        chunks: [{ content: "あ" }],
      })
    )._unsafeUnwrap();
    const session = (await getOrCreateDefaultSession(db, "2026-07-05"))._unsafeUnwrap();
    expect(saved.entry.sessionId).toBe(session.id);
  });

  test("名前付きセッションへの保存はデフォルトと独立", async () => {
    const date = "2026-07-05";
    const named = (await createSession(db, { name: "調査", date }))._unsafeUnwrap();
    (
      await saveSnapshot(db, {
        date,
        sessionId: named.id,
        raw: "b",
        converted: "い",
        chunks: [{ content: "い" }],
      })
    )._unsafeUnwrap();
    (
      await saveSnapshot(db, { date, raw: "a", converted: "あ", chunks: [{ content: "あ" }] })
    )._unsafeUnwrap();

    // getEntryWithChunks(date) はデフォルトセッションのみ返す
    const byDate = (await getEntryWithChunks(db, date))._unsafeUnwrap();
    expect(byDate?.entry.raw).toBe("a");

    const bySession = (await getSessionEntryWithChunks(db, named.id))._unsafeUnwrap();
    expect(bySession?.entry.raw).toBe("b");
    expect(bySession?.chunks.map((c) => c.content)).toEqual(["い"]);
  });

  test("存在しない sessionId はエラー", async () => {
    const result = await saveSnapshot(db, {
      date: "2026-07-05",
      sessionId: 9999,
      raw: "x",
      converted: "x",
      chunks: [],
    });
    expect(result.isErr()).toBe(true);
  });
});

describe("setSessionTags", () => {
  test("全置換・重複と空白のみは除去", async () => {
    const s = (await createSession(db, { name: "調査", date: "2026-07-05" }))._unsafeUnwrap();
    (await setSessionTags(db, s.id, ["web", "web", " ", "調査"]))._unsafeUnwrap();
    (await setSessionTags(db, s.id, ["設計"]))._unsafeUnwrap();
    const [session] = (await listSessions(db))._unsafeUnwrap();
    expect(session?.tags).toEqual(["設計"]);
  });
});

describe("renameSession / deleteSession", () => {
  test("rename で名前が変わる", async () => {
    const s = (await createSession(db, { name: "旧", date: "2026-07-05" }))._unsafeUnwrap();
    (await renameSession(db, s.id, "新"))._unsafeUnwrap();
    const all = (await listSessions(db))._unsafeUnwrap();
    expect(all[0]?.name).toBe("新");
  });

  test("削除で entry・chunks・タグが連鎖削除される", async () => {
    const s = (await createSession(db, { name: "消す", date: "2026-07-05" }))._unsafeUnwrap();
    (
      await saveSnapshot(db, {
        date: "2026-07-05",
        sessionId: s.id,
        raw: "x",
        converted: "え",
        chunks: [{ content: "え" }],
      })
    )._unsafeUnwrap();
    (await setSessionTags(db, s.id, ["tag"]))._unsafeUnwrap();

    (await deleteSession(db, s.id))._unsafeUnwrap();

    expect((await getSessionEntryWithChunks(db, s.id))._unsafeUnwrap()).toBeNull();
    expect(await db.select().from(sessionTags)).toHaveLength(0);
  });
});

const kek = () => sodium.randombytes_buf(32);

describe("暗号 ON のセッション", () => {
  test("name は at-rest で平文にならず、読み出しで復号される", async () => {
    await initCrypto(db, kek());
    (await createSession(db, { name: "秘密の計画", date: "2026-07-05" }))._unsafeUnwrap();
    (await getOrCreateDefaultSession(db, "2026-07-05"))._unsafeUnwrap();

    const raw = await db.select({ name: sessions.name }).from(sessions);
    const names = raw.map((r) => r.name);
    expect(names).not.toContain("秘密の計画");
    // デフォルトセッションの NULL は NULL のまま（name IS NULL 判定を保つ）
    expect(names).toContain(null);

    const all = (await listSessions(db))._unsafeUnwrap();
    expect(new Set(all.map((s) => s.name))).toEqual(new Set([null, "秘密の計画"]));
  });

  test("セッションタグは at-rest で平文にならず、fingerprint で重複排除される", async () => {
    await initCrypto(db, kek());
    const s = (await createSession(db, { name: "n", date: "2026-07-05" }))._unsafeUnwrap();
    (await setSessionTags(db, s.id, ["秘匿タグ", "秘匿タグ"]))._unsafeUnwrap();

    const rows = await db.select().from(sessionTags);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).not.toContain("秘匿");
    expect(rows[0]?.nameFingerprint).not.toContain("秘匿");

    const [session] = (await listSessions(db))._unsafeUnwrap();
    expect(session?.tags).toEqual(["秘匿タグ"]);
  });
});
