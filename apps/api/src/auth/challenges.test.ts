import { beforeEach, describe, expect, test } from "bun:test";
import { count } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { authChallenges } from "@zakki/api/db/schema.ts";
import * as schema from "@zakki/api/db/schema.ts";
import {
  CHALLENGE_TTL_MS,
  consumeChallenge,
  issueChallenge,
  MAX_LIVE_CHALLENGES,
} from "@zakki/api/auth/challenges.ts";

/**
 * challenge 発行の上限（issue #112 / #134）。
 *
 * options 系は未認証で叩けて 1 回ごとに DB へ 1 行書く。zone を持たない
 * workers.dev 配備では前段の rate limiting が使えないため、アプリ層で
 * 生きている challenge の総数に上限を置いた。
 */

const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");

let db: ControlDb;

beforeEach(async () => {
  const path = join(mkdtempSync(join(tmpdir(), "zakki-chal-")), "control.sqlite");
  // oxlint-disable-next-line typescript/consistent-type-assertions -- node 版 → web 版の型の読み替え
  db = drizzle(createClient({ url: `file:${path}` }), { schema }) as unknown as ControlDb;
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

async function liveCount(): Promise<number> {
  const [row] = await db.select({ count: count() }).from(authChallenges);
  return row?.count ?? 0;
}

/** 生きている challenge を n 件だけ直接作る（上限に達した状態の再現） */
async function seedLive(n: number, now: number): Promise<void> {
  await db.insert(authChallenges).values(
    Array.from({ length: n }, (_, i) => ({
      challenge: `seed-${i}`,
      kind: "authentication",
      accountId: null,
      displayName: null,
      expiresAt: now + CHALLENGE_TTL_MS,
    })),
  );
}

describe("issueChallenge", () => {
  test("通常は発行して true を返す", async () => {
    const now = Date.now();

    expect(await issueChallenge(db, { challenge: "c1", kind: "authentication", now })).toBe(true);
    expect(await liveCount()).toBe(1);
  });

  test("上限に達していたら書かずに false を返す", async () => {
    const now = Date.now();
    await seedLive(MAX_LIVE_CHALLENGES, now);

    expect(await issueChallenge(db, { challenge: "over", kind: "authentication", now })).toBe(
      false,
    );
    // 1 行も増えていない
    expect(await liveCount()).toBe(MAX_LIVE_CHALLENGES);
  });

  test("期限切れは掃除されるので、上限は「生きている数」に効く", async () => {
    const now = Date.now();
    await seedLive(MAX_LIVE_CHALLENGES, now);

    // TTL を跨いだ時刻で叩くと、溜まっていた行は掃除され発行できる
    const later = now + CHALLENGE_TTL_MS + 1;
    expect(
      await issueChallenge(db, { challenge: "next", kind: "authentication", now: later }),
    ).toBe(true);
    expect(await liveCount()).toBe(1);
  });

  test("上限で弾かれた challenge は消費もできない（そもそも記録されていない）", async () => {
    const now = Date.now();
    await seedLive(MAX_LIVE_CHALLENGES, now);
    await issueChallenge(db, { challenge: "over", kind: "authentication", now });

    const consumed = await consumeChallenge(db, { challenge: "over", kind: "authentication", now });

    expect(consumed).toEqual({ ok: false, reason: "unknown" });
  });
});
