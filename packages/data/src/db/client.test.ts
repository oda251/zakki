import { describe, expect, test } from "bun:test";
import { openClient } from "./client.ts";

describe("openClient の PRAGMA 設定", () => {
  test("ローカル DB は WAL + busy_timeout で開く（書き込み中の読みをブロックしない）", async () => {
    const { client } = await openClient(":memory:"); // :memory: は一時ファイルへ写される
    const journal = await client.execute("PRAGMA journal_mode");
    const mode = journal.rows[0]?.["journal_mode"];
    expect(typeof mode === "string" ? mode.toLowerCase() : mode).toBe("wal");
    const busy = await client.execute("PRAGMA busy_timeout");
    expect(Number(busy.rows[0]?.["timeout"])).toBe(5000);
  });
});
