import MiniSearch from "minisearch";
import { readingText, toKatakana } from "@/analysis/tokenizer.ts";
import type { ChunkWithDate } from "@/entry/queries.ts";
import { convertRomaji } from "@/romaji/convert.ts";

/**
 * MiniSearch による全文検索（docs/FEATURES.md §形態素解析・全文検索）。
 *
 * 照合は文字バイグラム。本文（表層）に加えて lindera による読みテキスト
 * （カタカナ）も索引するため、ローマ字→かなのクエリでも漢字本文に当たる
 * （例: 「jidouhozon」→「じどうほぞん」→ ジドウホゾン → 「自動保存」）。
 * かな連続クエリは形態素境界で分割できないため、語単位でなくバイグラムを使う。
 */

export interface SearchHit {
  id: number;
  title: string;
  content: string;
  date: string;
  position: number;
}

interface SearchDoc extends ChunkWithDate {
  reading: string;
}

export type SearchIndex = MiniSearch<SearchDoc>;

const STRIP = /[\s。、．，！？!?.,「」()（）\n]/g;

function bigrams(text: string): string[] {
  const s = text.toLowerCase().replace(STRIP, "");
  if (s.length === 0) {
    return [];
  }
  if (s.length <= 2) {
    return [s];
  }
  const grams: string[] = [];
  for (let i = 0; i < s.length - 1; i++) {
    grams.push(s.slice(i, i + 2));
  }
  return grams;
}

export function buildIndex(chunks: ChunkWithDate[]): SearchIndex {
  const index = new MiniSearch<SearchDoc>({
    fields: ["title", "content", "reading"],
    storeFields: ["title", "content", "date", "position"],
    tokenize: bigrams,
    searchOptions: {
      combineWith: "AND",
    },
  });
  index.addAll(chunks.map((c) => ({ ...c, reading: readingText(c.content) })));
  return index;
}

/** クエリはローマ字のまま受け取り、かな→カタカナへ正規化して検索する */
export function searchChunks(index: SearchIndex, query: string): SearchHit[] {
  const kana = convertRomaji(query, { flush: true }).converted.trim();
  if (kana === "") {
    return [];
  }
  return index.search(toKatakana(kana)).map((r) => ({
    id: Number(r.id),
    title: String(r["title"]),
    content: String(r["content"]),
    date: String(r["date"]),
    position: Number(r["position"]),
  }));
}
