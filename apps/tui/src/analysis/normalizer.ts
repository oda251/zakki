import { eq } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { chunkTags, tags } from "@zakki/data/db/schema.ts";
import type { TextGenerator } from "@zakki/tui/llm/client.ts";

/**
 * タグのオントロジー整理（docs/FEATURES.md 候補6）。
 * 表記揺れ（編集距離）と意味的近傍（embedding）の統合を「提案」として返し、
 * 適用は明示操作（CLI の --apply）に限る。代表タグは出現数が多い方。
 */

export interface TagWithCount {
  name: string;
  count: number;
}

export interface MergeProposal {
  /** 統合されて消えるタグ */
  from: string;
  /** 統合先（代表）タグ */
  to: string;
  reason: "edit-distance" | "embedding";
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0] ?? 0;
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const temp = dp[i] ?? 0;
      dp[i] = Math.min(
        (dp[i] ?? 0) + 1,
        (dp[i - 1] ?? 0) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = temp;
    }
  }
  return dp[a.length] ?? 0;
}

const MIN_LENGTH_FOR_EDIT_DISTANCE = 3;
const EMBEDDING_MERGE_MIN_SCORE = 0.92;

/** 出現数が多い方（同数なら短い方）を代表にしたペアを返す */
function orient(a: TagWithCount, b: TagWithCount, reason: MergeProposal["reason"]): MergeProposal {
  const [from, to] =
    a.count > b.count || (a.count === b.count && a.name.length <= b.name.length) ? [b, a] : [a, b];
  return { from: from.name, to: to.name, reason };
}

export function proposeTagMerges(
  tagCounts: TagWithCount[],
  similarity?: (a: string, b: string) => number,
): MergeProposal[] {
  const proposals: MergeProposal[] = [];
  const merged = new Set<string>();
  const sorted = tagCounts.toSorted((a, b) => b.count - a.count);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (a === undefined || b === undefined) continue;
      if (merged.has(a.name) || merged.has(b.name)) continue;
      const longEnough =
        a.name.length >= MIN_LENGTH_FOR_EDIT_DISTANCE &&
        b.name.length >= MIN_LENGTH_FOR_EDIT_DISTANCE;
      if (longEnough && levenshtein(a.name, b.name) === 1) {
        const p = orient(a, b, "edit-distance");
        proposals.push(p);
        merged.add(p.from);
        continue;
      }
      if (similarity !== undefined && similarity(a.name, b.name) >= EMBEDDING_MERGE_MIN_SCORE) {
        const p = orient(a, b, "embedding");
        proposals.push(p);
        merged.add(p.from);
      }
    }
  }
  return proposals;
}

/**
 * LLM があれば embedding 由来の提案を類義判定でフィルタする（docs/FEATURES.md §ローカル LLM）。
 * 編集距離由来（表記揺れ）は判定不要としてそのまま通す。LLM 失敗時は提案を保守的に落とす。
 */
export async function filterProposalsWithLlm(
  proposals: MergeProposal[],
  llm: TextGenerator,
): Promise<MergeProposal[]> {
  const result: MergeProposal[] = [];
  for (const proposal of proposals) {
    if (proposal.reason === "edit-distance") {
      result.push(proposal);
      continue;
    }
    const judged = await llm.generate(
      `「${proposal.from}」と「${proposal.to}」は同じ意味のタグですか。yes か no のみで答えてください。`,
    );
    if (
      judged.match(
        (t) => /yes/i.test(t),
        () => false,
      )
    ) {
      result.push(proposal);
    }
  }
  return result;
}

/** 提案を適用する: chunk_tags を代表タグへ付け替え、空になったタグを消す */
export function applyTagMerges(
  db: Db,
  proposals: MergeProposal[],
): ResultAsync<{ merged: number }, DbError> {
  return tryDbAsync(async () => {
    await db.transaction(async (tx) => {
      const rows = await tx.select().from(tags);
      const idByName = new Map(rows.map((r) => [r.name, r.id]));
      for (const proposal of proposals) {
        const fromId = idByName.get(proposal.from);
        const toId = idByName.get(proposal.to);
        if (fromId === undefined || toId === undefined) continue;
        const existing = new Set(
          (await tx.select().from(chunkTags).where(eq(chunkTags.tagId, toId))).map(
            (r) => r.chunkId,
          ),
        );
        for (const row of await tx.select().from(chunkTags).where(eq(chunkTags.tagId, fromId))) {
          if (!existing.has(row.chunkId)) {
            await tx
              .insert(chunkTags)
              .values({ chunkId: row.chunkId, tagId: toId, score: row.score });
          }
        }
        await tx.delete(chunkTags).where(eq(chunkTags.tagId, fromId));
        await tx.delete(tags).where(eq(tags.id, fromId));
      }
    });
    return { merged: proposals.length };
  });
}
