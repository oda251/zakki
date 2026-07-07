import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ok } from "neverthrow";
import { seedDayChunks } from "@zakki/data/chunk/testing.ts";
import type { Db, DbHandle } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import { chunks, chunkTags, links } from "@zakki/data/db/schema.ts";
import { analyzeChanged, syncWithAnalysisReset } from "./service.ts";

/**
 * sync 後の増分解析リセット（issue #55）。実際の Turso 往復はオフラインで検証
 * できない（connect.test.ts 参照）ため、「外部書き込み」は同一ファイルへの別
 * コネクション（他デバイス相当）で再現し、pull 結果（pulled）は固定した
 * DbHandle で与える。
 */

/** 同一 DB ファイルを 2 コネクションで開く。external が外部ライタを模す */
async function openPair(): Promise<{ local: Db; external: Db }> {
  const path = join(mkdtempSync(join(tmpdir(), "zakki-sync-")), "db.sqlite");
  const local = await createDb(path);
  const external = await createDb(path);
  return { local, external };
}

/** pull 結果を固定した DbHandle（sync 本体は connect.ts の責務でここでは模擬する） */
function handleWith(db: Db, pulled: boolean): DbHandle {
  return { db, sync: () => Promise.resolve(ok({ pulled })) };
}

/** チャンクに付いたタグ名（ソート済み） */
async function tagNamesOf(db: Db, chunkId: number): Promise<string[]> {
  const rows = await db.select().from(chunkTags).where(eq(chunkTags.chunkId, chunkId));
  const tagRows = await db.query.tags.findMany();
  const nameById = new Map(tagRows.map((t) => [t.id, t.name]));
  return rows.map((r) => nameById.get(r.tagId) ?? "?").toSorted();
}

describe("syncWithAnalysisReset（issue #55）", () => {
  test("sync が変更を取り込んだら次パスは全量へフォールバックし、リモート由来チャンクを解析する", async () => {
    const { local, external } = await openPair();
    await seedDayChunks(local, "2026-06-10", ["かな漢字変換の辞書を調べた。"]);
    (await analyzeChanged(local))._unsafeUnwrap();

    // 外部ライタ（別コネクション）が chunk を追加 → pulled=true の sync で取り込みを通知
    const { chunks: added } = await seedDayChunks(external, "2026-06-11", [
      "かな漢字変換の辞書を整備した。最悪だ。",
    ]);
    const remote = added[0];
    if (remote === undefined) throw new Error("seed 不足");
    (await syncWithAnalysisReset(handleWith(local, true))())._unsafeUnwrap();

    // スナップショット破棄済みなので全量（本文チャンク 2 件とも解析）になる
    const summary = (await analyzeChanged(local))._unsafeUnwrap();
    expect(summary.taggedChunks).toBe(2);

    // 受け入れ基準: リモート由来チャンクにタグ・リンク・極性が付与される
    expect((await tagNamesOf(local, remote.id)).length).toBeGreaterThan(0);
    const linkRows = await local.select().from(links);
    expect(linkRows.some((r) => r.fromChunkId === remote.id || r.toChunkId === remote.id)).toBe(
      true,
    );
    const [row] = await local
      .select({ polarity: chunks.polarity })
      .from(chunks)
      .where(eq(chunks.id, remote.id));
    expect(row?.polarity).not.toBeNull();
  });

  test("updatedAt が動かない外部上書きも、取り込み後の全量フォールバックで拾う", async () => {
    const { local, external } = await openPair();
    const { chunks: seeded } = await seedDayChunks(local, "2026-06-10", [
      "散歩して天気の話をした。",
    ]);
    const target = seeded[0];
    if (target === undefined) throw new Error("seed 不足");
    (await analyzeChanged(local))._unsafeUnwrap();
    // 初回パスの極性 bump で updatedAt が進むため、もう 1 パスでスナップショットを収束させる
    (await analyzeChanged(local))._unsafeUnwrap();
    const before = await tagNamesOf(local, target.id);
    expect(before.length).toBeGreaterThan(0);

    // 外部上書き（updatedAt 据え置き）。sync の取り込みは本プロセスの保存経路を通らない
    await external
      .update(chunks)
      .set({ content: "かな漢字変換の辞書を調べた。" })
      .where(eq(chunks.id, target.id));

    // スナップショット破棄なしの増分パスはこの変更を見逃す（単一ライタ前提の破れ）
    expect((await analyzeChanged(local))._unsafeUnwrap()).toEqual({ taggedChunks: 0, links: 0 });
    expect(await tagNamesOf(local, target.id)).toEqual(before);

    // pulled=true の sync 後は全量へフォールバックして正を回復する
    (await syncWithAnalysisReset(handleWith(local, true))())._unsafeUnwrap();
    (await analyzeChanged(local))._unsafeUnwrap();
    const after = await tagNamesOf(local, target.id);
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toEqual(before);
  });

  test("no-op sync では増分のまま（全量の無駄打ちをしない）", async () => {
    const { local } = await openPair();
    await seedDayChunks(local, "2026-06-10", [
      "かな漢字変換の辞書を調べた。",
      "散歩して天気の話をした。",
    ]);
    (await analyzeChanged(local))._unsafeUnwrap();

    (await syncWithAnalysisReset(handleWith(local, false))())._unsafeUnwrap();

    // スナップショットは維持され、変更ゼロの増分パス（全量なら taggedChunks=2 になる）
    expect((await analyzeChanged(local))._unsafeUnwrap()).toEqual({ taggedChunks: 0, links: 0 });
  });
});
