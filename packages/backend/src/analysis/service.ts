import type { Result, ResultAsync } from "neverthrow";
import { AAD } from "@zakki/core/crypto/aad.ts";
import { applyAnalysisPlan } from "@zakki/data/analysis/apply.ts";
import {
  listAnalyzableChunkHeads,
  listAnalyzableChunks,
  readChunkContents,
  readChunkPolarities,
  readChunkTagScores,
} from "@zakki/data/analysis/queries.ts";
import type { Db, DbHandle } from "@zakki/data/db/client.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { computeLinks, computeLinksFor } from "./linker.ts";
import { LruCache } from "./lru.ts";
import { planWrites } from "./plan.ts";
import type { TagScore } from "./tagger.ts";
import { computeTags } from "./tagger.ts";
import { extractNouns } from "./tokenizer.ts";

export interface AnalysisSummary {
  taggedChunks: number;
  links: number;
}

/**
 * content → 名詞列のメモ（同一内容の再解析を避ける。プロセス内キャッシュ）。
 * 長寿命プロセス（web サーバ）での無制限成長を防ぐため LRU で上限化する（issue #54）。
 */
const nounCache = new LruCache<string, string[]>(1000);

function nounsOf(content: string): string[] {
  let nouns = nounCache.get(content);
  if (nouns === undefined) {
    nouns = extractNouns(content);
    nounCache.set(content, nouns);
  }
  return nouns;
}

/** 解析済みチャンク 1 件のプロセス内状態（増分検出と再解析回避に使う） */
interface ChunkState {
  updatedAt: string;
  /** DB 格納値（暗号 ON は暗号文）。updatedAt の同刻衝突に備えた第二の変化検知 */
  stored: string;
  /** 平文 content。暗号 ON でも平文を保持するのは nounCache と同水準の割り切り */
  content: string;
  nouns: readonly string[];
}

/**
 * 前回解析のプロセス内スナップショット（issue #24）。プロセスごとに
 * 「起動後初回は全量、以降は増分」で運用する（DB 側に解析メタは持たない）。
 * tags は前回 chunk_tags に書いた内容（平文名 + スコア）で、差分書き込みの基準。
 */
interface AnalysisSnapshot {
  chunks: Map<number, ChunkState>;
  tags: Map<number, TagScore[]>;
}

const snapshots = new WeakMap<Db, AnalysisSnapshot>();

/**
 * プロセス内スナップショットを破棄し、次回の解析パスを全量（{@link analyzeAll}）へ
 * フォールバックさせる（issue #55）。増分解析は「本プロセスが唯一のライタ」を前提に
 * 差分基準を持つため、外部書き込み（Turso sync の pull、RxDB replication のサーバ
 * 書き込み #42-#45）を取り込んだ直後に呼んで正を回復する。両経路で共有する単一の口。
 * nounCache は content キーの決定的メモ（値は content のみの関数）なので破棄しない。
 */
export function invalidateAnalysisSnapshot(db: Db): void {
  snapshots.delete(db);
}

/**
 * DbHandle.sync を包み、リモートの変更を実際に取り込んだ（pulled）場合にだけ
 * スナップショットを破棄する sync 関数を返す（issue #55）。no-op sync では増分の
 * まま（全量の無駄打ちをしない）。合成点（web bootstrap / TUI）は生の sync では
 * なくこれを使い、単一ライタ前提の破れを取り込み時点で塞ぐ。
 */
export function syncWithAnalysisReset(handle: DbHandle): () => Promise<Result<void, DbError>> {
  return async () => {
    const result = await handle.sync();
    return result.map((outcome) => {
      if (outcome.pulled) invalidateAnalysisSnapshot(handle.db);
    });
  };
}

/**
 * 全チャンクのタグ付けと関連付けを再計算して永続化する（docs/CONCEPT.md §3）。
 * 決定的・冪等な全量再計算で、「正」を回復する手段（CLI の stats など）。
 * 保存ごとのバックグラウンド解析には {@link analyzeChanged} を使う。
 */
export function analyzeAll(db: Db): ResultAsync<AnalysisSummary, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    // 日付チャンク（構造ノード, content = 日付）は解析対象にしない
    const rawChunks = await listAnalyzableChunks(db);
    const oldPolarity = new Map(rawChunks.map((c) => [c.id, c.polarity]));
    // 解析（名詞抽出・極性）は平文に対して行う。暗号 ON は復号した content を使う。
    const states = new Map<number, ChunkState>();
    for (const c of rawChunks) {
      const content =
        crypto === undefined ? c.content : crypto.decString(c.content, AAD.chunkContent);
      states.set(c.id, {
        updatedAt: c.updatedAt,
        stored: c.content,
        content,
        nouns: nounsOf(content),
      });
    }

    const nounsByChunk = new Map([...states].map(([id, s]) => [id, s.nouns]));
    const tagsByChunk = computeTags(nounsByChunk);
    const linkCandidates = computeLinks(nounsByChunk);
    // 旧タグは DB 実体から読む（全量パスは「正」の回復手段で、スナップショットに頼らない）。
    const oldTags = await readChunkTagScores(db);
    const now = new Date().toISOString();

    // 極性（決定的, docs/FEATURES.md §整理・想起系 7）は全 content から算出する。
    const contentById = new Map([...states].map(([id, s]) => [id, s.content]));
    const plan = planWrites({
      newTags: tagsByChunk,
      oldTags,
      contentById,
      oldPolarity,
      changed: "all",
      links: linkCandidates,
    });
    await applyAnalysisPlan(db, plan, now);

    snapshots.set(db, { chunks: states, tags: tagsByChunk });
    return { taggedChunks: tagsByChunk.size, links: linkCandidates.length };
  });
}

/**
 * 変更されたチャンクだけを再解析する増分パス（issue #24）。適用後の DB 状態は
 * {@link analyzeAll} の全量再計算と一致する（差分書き込みのみで達成）。
 * スナップショットが無い（起動後初回）は analyzeAll に委譲する。
 *
 * 前提: 本プロセス・本 Db インスタンスが唯一のライタであること。外部書き込み
 * （Turso sync の pull 等）を取り込んだ後は {@link invalidateAnalysisSnapshot} で
 * スナップショットを破棄し、次パスを全量へフォールバックさせて正を回復する（issue #55）。
 *
 * @returns taggedChunks = 再解析した変更チャンク数、links = 張り替えたリンク数
 */
export function analyzeChanged(db: Db): ResultAsync<AnalysisSummary, DbError> {
  const snapshot = snapshots.get(db);
  if (snapshot === undefined) {
    return analyzeAll(db);
  }
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    // 第 1 段: id + updatedAt だけを取得し、スナップショットとの比較で「動いた候補」を
    // 絞る。updatedAt が一致する行は content を取得しない（変更ゼロのパスでは
    // content 転送が一切発生しない）
    const idRows = await listAnalyzableChunkHeads(db);
    const candidateIds = idRows
      .filter((row) => {
        const prev = snapshot.chunks.get(row.id);
        return prev === undefined || prev.updatedAt !== row.updatedAt;
      })
      .map((row) => row.id);

    // 第 2 段: 候補行だけ content を追加取得する
    const storedById = await readChunkContents(db, candidateIds);

    const states = new Map<number, ChunkState>();
    const changed = new Set<number>();
    for (const row of idRows) {
      const prev = snapshot.chunks.get(row.id);
      const stored = storedById.get(row.id);
      if (stored === undefined) {
        // 候補外 = updatedAt 一致。単一ライタ前提の下では内容も不変とみなす
        if (prev !== undefined) states.set(row.id, prev);
        continue;
      }
      // stored 比較（候補に対する第二の変化検知）。updatedAt は動いたが格納バイト列が
      // 一致するなら内容は不変（暗号 OFF での同一内容再保存など）で復号もスキップ
      if (prev !== undefined && prev.stored === stored) {
        states.set(row.id, {
          updatedAt: row.updatedAt,
          stored,
          content: prev.content,
          nouns: prev.nouns,
        });
        continue;
      }
      const content = crypto === undefined ? stored : crypto.decString(stored, AAD.chunkContent);
      if (prev !== undefined && prev.content === content) {
        // 再保存で updatedAt だけ進んだ（内容は同一）。名詞列を引き継ぎ変更扱いにしない
        states.set(row.id, { updatedAt: row.updatedAt, stored, content, nouns: prev.nouns });
        continue;
      }
      states.set(row.id, { updatedAt: row.updatedAt, stored, content, nouns: nounsOf(content) });
      changed.add(row.id);
    }
    let removedCount = 0;
    for (const id of snapshot.chunks.keys()) {
      if (!states.has(id)) removedCount += 1;
    }

    if (changed.size === 0 && removedCount === 0) {
      snapshots.set(db, { chunks: states, tags: snapshot.tags });
      return { taggedChunks: 0, links: 0 };
    }

    const nounsByChunk = new Map([...states].map(([id, s]) => [id, s.nouns]));
    const tagsByChunk = computeTags(nounsByChunk);
    const linkCandidates = computeLinksFor(nounsByChunk, changed);

    // 極性は content のみの関数なので changed のチャンクだけ再計算する。旧極性も
    // changed に限って読む（変更ゼロのパスでは polarity 取得も発生しない）。
    const contentById = new Map([...changed].map((id) => [id, states.get(id)?.content ?? ""]));
    const oldPolarity = await readChunkPolarities(db, [...changed]);
    const now = new Date().toISOString();

    // 旧タグは前回のスナップショット（前回 chunk_tags に書いた内容）。増分パスは
    // 本プロセスが唯一のライタである前提で、DB を読み直さずスナップショットで差分を取る。
    const plan = planWrites({
      newTags: tagsByChunk,
      oldTags: snapshot.tags,
      contentById,
      oldPolarity,
      changed,
      links: linkCandidates,
    });
    await applyAnalysisPlan(db, plan, now);

    snapshots.set(db, { chunks: states, tags: tagsByChunk });
    return { taggedChunks: changed.size, links: linkCandidates.length };
  });
}
