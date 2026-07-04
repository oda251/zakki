import { describe, expect, test } from "bun:test";
import { wrapPaste } from "@zakki/core/conversion/paste.ts";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { getOrCreateDefaultSession } from "@zakki/data/session/repository.ts";
import { localDate, persistEntry, saveSessionEntry } from "./autosave.ts";

let db: Db;

describe("persistEntry（自動保存の入口）", () => {
  test("converted からチャンクを再生成して保存する", async () => {
    db = await createDb(":memory:");
    const saved = (
      await persistEntry(db, {
        date: "2026-06-12",
        raw: "hare.Claude tohanashita.",
        converted: "はれ。Claudeとはなした。",
      })
    )._unsafeUnwrap();

    expect(saved.chunks.map((c) => c.content)).toEqual(["はれ。", "Claudeとはなした。"]);
  });

  test("マーカー付き converted は凍結リテラル境界で分割し、保存値は strip される", async () => {
    db = await createDb(":memory:");
    // Enter 終端（句点なし）の 2 文が凍結された raw 相当。境界はマーカーのみ
    const converted = wrapPaste("ぶにち") + wrapPaste("ぶんい");
    const saved = (
      await persistEntry(db, {
        date: "2026-06-12",
        raw: "bunichi\nbunni\n",
        converted,
      })
    )._unsafeUnwrap();

    // 1 投稿に結合されず、凍結リテラル単位で 2 チャンクになる
    expect(saved.chunks.map((c) => c.content)).toEqual(["ぶにち", "ぶんい"]);
    // entries.converted の保存値にマーカー（PUA）は残らない
    expect(saved.entry.converted).toBe("ぶにちぶんい");
  });

  test("saveSessionEntry も同様にマーカー境界で分割し、保存値は strip される（web 経路）", async () => {
    db = await createDb(":memory:");
    const session = (await getOrCreateDefaultSession(db, "2026-06-12"))._unsafeUnwrap();
    const saved = (
      await saveSessionEntry(db, session.id, {
        raw: "bunichi\nbunni\n",
        converted: wrapPaste("ぶにち") + wrapPaste("ぶんい"),
      })
    )._unsafeUnwrap();

    expect(saved?.chunks.map((c) => c.content)).toEqual(["ぶにち", "ぶんい"]);
    expect(saved?.entry.converted).toBe("ぶにちぶんい");
  });
});

describe("localDate", () => {
  test("ローカル日付を YYYY-MM-DD で返す", () => {
    expect(localDate(new Date(2026, 5, 12, 23, 59))).toBe("2026-06-12");
  });
});
