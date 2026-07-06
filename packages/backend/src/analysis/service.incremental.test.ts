import { describe, expect, test } from "bun:test";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { chunks, chunkTags, links, tags } from "@zakki/data/db/schema.ts";
import { listChunksWithDate } from "@zakki/data/chunk/queries.ts";
import { seedDayChunks } from "@zakki/data/chunk/testing.ts";
import { addManualLink } from "@zakki/data/link/repository.ts";
import { analyzeAll, analyzeChanged } from "./service.ts";

async function seed(db: Db, date: string, contents: string[]): Promise<void> {
  await seedDayChunks(db, date, contents);
}

/**
 * 解析が書き込む DB 状態の正規化ビュー。タグは autoincrement id が実行順で
 * 変わり得るため名前で比較する（暗号 OFF 前提。ON の一致は crypto テスト側）。
 */
interface AnalysisState {
  tagNames: string[];
  tagsByChunk: Map<number, [string, number][]>;
  links: [number, number, number, string][];
  polarityByChunk: Map<number, number | null>;
}

async function readState(db: Db): Promise<AnalysisState> {
  const tagRows = await db.select().from(tags);
  const nameById = new Map(tagRows.map((r) => [r.id, r.name]));
  const tagsByChunk = new Map<number, [string, number][]>();
  for (const row of await db.select().from(chunkTags)) {
    const list = tagsByChunk.get(row.chunkId) ?? [];
    list.push([nameById.get(row.tagId) ?? "?", row.score]);
    tagsByChunk.set(row.chunkId, list);
  }
  for (const list of tagsByChunk.values()) {
    list.sort((a, b) => a[0].localeCompare(b[0]));
  }
  const linkRows = (await db.select().from(links))
    .map((r): [number, number, number, string] => [r.fromChunkId, r.toChunkId, r.score, r.origin])
    .toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  const polarityByChunk = new Map(
    (await db.select({ id: chunks.id, polarity: chunks.polarity }).from(chunks)).map((r) => [
      r.id,
      r.polarity,
    ]),
  );
  return {
    tagNames: tagRows.map((r) => r.name).toSorted(),
    tagsByChunk,
    links: linkRows,
    polarityByChunk,
  };
}

describe("analyzeChanged（増分解析）", () => {
  test("増分適用後の DB 状態が全量再計算と一致する", async () => {
    // 同一の操作列を 2 つの DB に適用し、増分（inc）と全量（full）を比較する。
    // 挿入順が同じなので chunk id は両者で一致する。
    const inc = await createDb(":memory:");
    const full = await createDb(":memory:");
    const seedBoth = async (date: string, contents: string[]) => {
      await seed(inc, date, contents);
      await seed(full, date, contents);
    };

    // 初期コーパス（増分側は初回なので全量にフォールバック）
    await seedBoth("2026-06-10", ["かな漢字変換の辞書を調べた。", "散歩して天気の話をした。"]);
    await seedBoth("2026-06-11", ["変換エンジンの辞書を組み込んだ。"]);
    (await analyzeChanged(inc))._unsafeUnwrap();
    (await analyzeAll(full))._unsafeUnwrap();
    expect(await readState(inc)).toEqual(await readState(full));

    // 既存 entry の編集（内容変更 + チャンク追加）と新規 entry の追加。
    // チャンク数が変わるので TF-IDF スコアはコーパス全体で動く
    await seedBoth("2026-06-11", [
      "変換エンジンの辞書を差し替えた。",
      "天気の良い日に散歩へ出た。",
    ]);
    await seedBoth("2026-06-12", ["辞書の学習データを整備した。最悪だ。"]);
    (await analyzeChanged(inc))._unsafeUnwrap();
    (await analyzeAll(full))._unsafeUnwrap();
    expect(await readState(inc)).toEqual(await readState(full));

    // チャンク削除（少ない数で再保存）。リンク・タグ・孤立タグ削除の追従を見る
    await seedBoth("2026-06-10", ["かな漢字変換の辞書を調べた。"]);
    (await analyzeChanged(inc))._unsafeUnwrap();
    (await analyzeAll(full))._unsafeUnwrap();
    expect(await readState(inc)).toEqual(await readState(full));
  });

  test("増分適用後に analyzeAll を流しても状態が変わらない（同一 DB での一致）", async () => {
    const db = await createDb(":memory:");
    await seed(db, "2026-06-10", ["かな漢字変換の辞書を調べた。", "散歩して天気の話をした。"]);
    (await analyzeChanged(db))._unsafeUnwrap();
    await seed(db, "2026-06-10", ["かな漢字変換の辞書を調べ直した。", "散歩して天気の話をした。"]);
    await seed(db, "2026-06-11", ["変換エンジンの辞書を組み込んだ。"]);
    (await analyzeChanged(db))._unsafeUnwrap();

    const afterIncremental = await readState(db);
    (await analyzeAll(db))._unsafeUnwrap();
    expect(await readState(db)).toEqual(afterIncremental);
  });

  test("変更が無ければ何も再解析しない（updatedAt だけ進む再保存も対象外）", async () => {
    const db = await createDb(":memory:");
    await seed(db, "2026-06-10", ["かな漢字変換の辞書を調べた。"]);
    (await analyzeChanged(db))._unsafeUnwrap();

    const second = (await analyzeChanged(db))._unsafeUnwrap();
    expect(second).toEqual({ taggedChunks: 0, links: 0 });

    // 同一内容の再保存（updatedAt は進むが content は同一）
    await seed(db, "2026-06-10", ["かな漢字変換の辞書を調べた。"]);
    const third = (await analyzeChanged(db))._unsafeUnwrap();
    expect(third).toEqual({ taggedChunks: 0, links: 0 });
  });

  test("エントリ中間へのチャンク挿入（position シフトが固定 id の content 変更として検出される）", async () => {
    // chunks は (entry_id, position) で upsert されるため、中間へのチャンク挿入は
    // 後続 position の行 id はそのままに content だけが後ろへシフトして書き換わる。
    // updatedAt + 格納値比較の増分検出がこれを正しく「変更」として拾えるかを見る。
    const inc = await createDb(":memory:");
    const full = await createDb(":memory:");
    const seedBoth = async (date: string, contents: string[]) => {
      await seed(inc, date, contents);
      await seed(full, date, contents);
    };

    await seedBoth("2026-06-10", [
      "最初のチャンク。散歩の話。",
      "二番目のチャンク。天気の話。",
      "三番目のチャンク。辞書の話。",
    ]);
    (await analyzeChanged(inc))._unsafeUnwrap();
    (await analyzeAll(full))._unsafeUnwrap();
    expect(await readState(inc)).toEqual(await readState(full));

    // position 1 に新しいチャンクを挿入 → 既存 position 1, 2 の id は
    // そのままシフトした内容で上書きされ、position 3 は新規行になる
    await seedBoth("2026-06-10", [
      "最初のチャンク。散歩の話。",
      "挿入された新しいチャンク。辞書の話。",
      "二番目のチャンク。天気の話。",
      "三番目のチャンク。辞書の話。",
    ]);
    (await analyzeChanged(inc))._unsafeUnwrap();
    (await analyzeAll(full))._unsafeUnwrap();
    expect(await readState(inc)).toEqual(await readState(full));
  });

  test("manual リンクは変更チャンクが関与しても増分パスで消えない", async () => {
    const db = await createDb(":memory:");
    await seed(db, "2026-06-10", ["最初の話。", "全然関係ない別の話。"]);
    (await analyzeChanged(db))._unsafeUnwrap();

    const body = (await listChunksWithDate(db))._unsafeUnwrap();
    const [a, b] = body.map((c) => c.id);
    if (a === undefined || b === undefined) throw new Error("seed 不足");

    (await addManualLink(db, a, b))._unsafeUnwrap();
    await seed(db, "2026-06-10", ["最初の話を書き直した。", "全然関係ない別の話。"]);
    (await analyzeChanged(db))._unsafeUnwrap();

    const rows = await db.select().from(links);
    expect(
      rows.some((r) => r.fromChunkId === a && r.toChunkId === b && r.origin === "manual"),
    ).toBe(true);
  });
});
