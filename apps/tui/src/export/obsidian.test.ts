import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportEntry } from "./obsidian.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zakki-export-"));
});

const DATE = "2026-06-12";

describe("exportEntry", () => {
  test("チャンクを frontmatter 付き Markdown として書き出す", async () => {
    const summary = (
      await exportEntry({
        vaultDir: dir,
        date: DATE,
        chunks: [
          { position: 0, content: "はれ。" },
          { position: 1, content: "Claudeとはなした。" },
        ],
      })
    )._unsafeUnwrap();

    expect(summary).toEqual({ written: 2, skipped: 0, deleted: 0 });
    const body = await readFile(join(dir, "2026-06-12-000.md"), "utf8");
    expect(body).toBe("---\ndate: 2026-06-12\nposition: 0\nsource: zakki\n---\n\nはれ。\n");
  });

  test("冪等: 同一内容の再エクスポートは書き込まない", async () => {
    const input = {
      vaultDir: dir,
      date: DATE,
      chunks: [{ position: 0, content: "はれ。" }],
    };
    (await exportEntry(input))._unsafeUnwrap();
    const second = (await exportEntry(input))._unsafeUnwrap();
    expect(second).toEqual({ written: 0, skipped: 1, deleted: 0 });
  });

  test("チャンクが減ったら対応する zakki 管理ファイルを削除する", async () => {
    (
      await exportEntry({
        vaultDir: dir,
        date: DATE,
        chunks: [
          { position: 0, content: "一" },
          { position: 1, content: "二" },
        ],
      })
    )._unsafeUnwrap();

    const summary = (
      await exportEntry({
        vaultDir: dir,
        date: DATE,
        chunks: [{ position: 0, content: "一" }],
      })
    )._unsafeUnwrap();

    expect(summary.deleted).toBe(1);
    expect(await readdir(dir)).toEqual(["2026-06-12-000.md"]);
  });

  test("マーカーのないユーザー自作ファイルは削除しない", async () => {
    const userFile = join(dir, "2026-06-12-999.md");
    await writeFile(userFile, "ユーザーのメモ", "utf8");

    (await exportEntry({ vaultDir: dir, date: DATE, chunks: [] }))._unsafeUnwrap();

    expect(await readFile(userFile, "utf8")).toBe("ユーザーのメモ");
  });

  test("他の日付のファイルには触れない", async () => {
    (
      await exportEntry({
        vaultDir: dir,
        date: "2026-06-11",
        chunks: [{ position: 0, content: "前日" }],
      })
    )._unsafeUnwrap();

    const summary = (
      await exportEntry({
        vaultDir: dir,
        date: DATE,
        chunks: [{ position: 0, content: "当日" }],
      })
    )._unsafeUnwrap();

    expect(summary.deleted).toBe(0);
    expect((await readdir(dir)).toSorted()).toEqual(["2026-06-11-000.md", "2026-06-12-000.md"]);
  });
});
