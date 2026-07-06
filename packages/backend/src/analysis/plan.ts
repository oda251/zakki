/**
 * 解析パス（全量 {@link ../analysis/service.ts:analyzeAll} / 増分 analyzeChanged）が
 * DB へ書き込む内容を宣言する純関数プラン。「何を書くか・どの条件で書くか」を
 * {@link planWrites} に閉じ込め、service 側の tx はこのプランを機械的に適用する
 * だけにする（読み取り・判定・書き込みの交錯を解く）。タグ id は DB 採番のため
 * プランは名前で持ち、適用時に解決する。
 */

import { scoreSentiment } from "@zakki/core/analysis/sentiment.ts";
import type { LinkCandidate } from "./linker.ts";
import type { TagScore } from "./tagger.ts";

export interface WritePlan {
  /** 確保すべきタグ名（tagRewrites で挿入するタグの名前集合） */
  tagNames: ReadonlySet<string>;
  /** chunk_tags を張り替えるチャンク（delete → insert）。新旧タグ列が変わったチャンクのみ */
  tagRewrites: { chunkId: number; tags: TagScore[] }[];
  /** auto リンクの張替え範囲。"all" = 全 auto を削除、配列 = そのチャンクが関与する auto のみ */
  relinkChunkIds: number[] | "all";
  /** 挿入する auto リンク（呼び出し側で computeLinks / computeLinksFor 済み） */
  insertLinks: LinkCandidate[];
  /** 極性の書き込み。bump = updatedAt を進めるか（差分取得が変更ノードを拾えるように） */
  polarityWrites: { chunkId: number; polarity: number; bump: boolean }[];
}

export interface PlanInput {
  /** 今回計算したタグ（解析対象チャンク全件）。Map 反復順が適用順になる */
  newTags: ReadonlyMap<number, TagScore[]>;
  /** 前回書き込んだタグ（全量は DB 実体、増分はスナップショット）。差分と bump の基準 */
  oldTags: ReadonlyMap<number, readonly TagScore[]>;
  /** 極性を算出するチャンクの平文 content（bump 対象範囲だけあればよい） */
  contentById: ReadonlyMap<number, string>;
  /** 前回極性（極性変化の判定基準） */
  oldPolarity: ReadonlyMap<number, number | null>;
  /**
   * 自身の content が変わったチャンク（bump 候補・relink 対象）。"all" は全量パス。
   * corpus 変動での他チャンクのタグ順位揺れは自身の変化ではないので bump しない
   * （差分ペイロードをユーザの変更に比例させる、増分パスの設計方針）。
   */
  changed: ReadonlySet<number> | "all";
  /** リンク候補（呼び出し側で computeLinks / computeLinksFor 済み） */
  links: readonly LinkCandidate[];
}

/** 前回書き込んだタグ列と完全一致か（名前・スコア・順序）。張替え要否の判定に使う */
export function tagListEquals(a: readonly TagScore[], b: readonly TagScore[] | undefined): boolean {
  if (b === undefined || a.length !== b.length) return false;
  return a.every((t, i) => t.name === b[i]?.name && t.score === b[i]?.score);
}

/**
 * 可視タグ名列（スコア降順の名前列）が一致か。bump 判定に使う。差分取得のペイロードに
 * 現れるのは名前列で、スコア値だけの変化は表示に影響しないため bump しない。
 */
function tagNamesEqual(
  a: readonly TagScore[] | undefined,
  b: readonly TagScore[] | undefined,
): boolean {
  const an = a ?? [];
  const bn = b ?? [];
  if (an.length !== bn.length) return false;
  return an.every((t, i) => t.name === bn[i]?.name);
}

/**
 * 解析結果（新タグ・リンク・content）と旧状態から、DB へ書く内容を算出する純関数。
 * 全量パスと増分パスの差は入力（oldTags の実体/スナップショット、changed の "all"/集合）
 * だけで表現し、判定ロジックは共通化する。
 */
export function planWrites(input: PlanInput): WritePlan {
  const { newTags, oldTags, contentById, oldPolarity, changed, links } = input;

  // タグ張替え: 新旧タグ列（名前+スコア+順序）が変わったチャンクだけ delete→insert。
  // スコア変化も張り替えることで、増分の chunk_tags 結果が全量再計算と一致する。
  const tagRewrites: { chunkId: number; tags: TagScore[] }[] = [];
  for (const [chunkId, tags] of newTags) {
    if (!tagListEquals(tags, oldTags.get(chunkId))) {
      tagRewrites.push({ chunkId, tags });
    }
  }
  const tagNames = new Set(tagRewrites.flatMap((r) => r.tags.map((t) => t.name)));

  // 極性・bump: changed のチャンクだけを対象にする。極性 or 自身の可視タグ名列が
  // 変わったチャンクを bump（updatedAt を進める）。全量パスは bump するチャンクだけ書き
  // （冪等再実行で全ノード再送になるのを防ぐ）、増分パスは changed を必ず書く
  // （content が変わっているため極性を更新する。updatedAt は bump 時のみ進める）。
  const polarityWrites: { chunkId: number; polarity: number; bump: boolean }[] = [];
  for (const [chunkId, content] of contentById) {
    if (changed !== "all" && !changed.has(chunkId)) continue;
    const polarity = scoreSentiment(content);
    const bump =
      polarity !== oldPolarity.get(chunkId) ||
      !tagNamesEqual(newTags.get(chunkId), oldTags.get(chunkId));
    if (changed === "all") {
      if (bump) polarityWrites.push({ chunkId, polarity, bump: true });
    } else {
      polarityWrites.push({ chunkId, polarity, bump });
    }
  }

  return {
    tagNames,
    tagRewrites,
    relinkChunkIds: changed === "all" ? "all" : [...changed],
    insertLinks: [...links],
    polarityWrites,
  };
}
