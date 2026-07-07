import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KanaKanjiEngine } from "@zakki/core/conversion/engine.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import type { KeyLike } from "@zakki/core/input/controller.ts";
import { applySearchKey } from "@zakki/core/input/controller.ts";
import { convertRomaji } from "@zakki/core/romaji/convert.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { ChunkWithDate } from "@zakki/data/chunk/queries.ts";
import { listChunksWithDate } from "@zakki/data/chunk/queries.ts";
import type { SearchIndex } from "@zakki/tui/search/index.ts";
import { buildIndex, searchChunks } from "@zakki/tui/search/index.ts";
import { searchSemantic } from "@zakki/tui/search/semantic.ts";

const SEARCH_RESULT_LIMIT = 8;
/** 全文ヒットと重複しない「意味が近い」補足の最大件数 */
const MAX_SEMANTIC_EXTRA = 4;

/**
 * 検索ペインの状態と配線（issue #57 で App.tsx から切り出し）:
 * 全文（bigram）索引の構築・セマンティック検索のデバウンス・検索モード中のキー処理。
 */
export function useSearch(options: {
  db: Db;
  engine: KanaKanjiEngine;
  /** ローカル embedding。null ならセマンティック補足は無効（決定的動作のみ） */
  embedder: Embedder | null;
  onMessage: (message: string) => void;
}) {
  const { db, engine, embedder, onMessage } = options;
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // 検索索引の非同期ロード完了で全文ヒットの再計算を駆動する
  const [searchIndexVersion, setSearchIndexVersion] = useState(0);
  const [semanticHits, setSemanticHits] = useState<ChunkWithDate[]>([]);
  const searchIndexRef = useRef<SearchIndex | null>(null);
  const searchChunksRef = useRef<Map<number, ChunkWithDate>>(new Map());

  /** 検索モードを開く。索引はペインを開いた時点の全チャンクから構築する（非同期ロード後に再描画） */
  const openSearch = useCallback(() => {
    void listChunksWithDate(db)
      .match(
        (chunks) => {
          searchChunksRef.current = new Map(chunks.map((c) => [c.id, c]));
          return buildIndex(chunks);
        },
        (e) => {
          onMessage(`検索: ${e.message}`);
          return null;
        },
      )
      .then((index) => {
        searchIndexRef.current = index;
        setSearchIndexVersion((v) => v + 1);
      });
    setSearchOpen(true);
  }, [db, onMessage]);

  /** 検索モード中のキーを処理する。true なら消費済み（検索中は全キーを握る） */
  const handleSearchKey = useCallback(
    (keyEvent: KeyLike): boolean => {
      if (!searchOpen) {
        return false;
      }
      const action = applySearchKey(searchQuery, keyEvent);
      if (action.type === "close") {
        setSearchOpen(false);
        setSearchQuery("");
        setSemanticHits([]);
      } else if (action.type === "edit") {
        setSearchQuery(action.query);
      }
      // "none" を含め検索中は全キーを消費する
      return true;
    },
    [searchOpen, searchQuery],
  );

  // セマンティック検索（docs/FEATURES.md 候補8）。実体は search/semantic.ts に委譲する
  useEffect(() => {
    const active = searchOpen && embedder !== null && searchQuery !== "";
    if (!active) {
      setSemanticHits([]);
    }
    const timer = setTimeout(() => {
      if (!active || embedder === null) {
        return;
      }
      void searchSemantic(
        searchQuery,
        engine,
        embedder,
        db,
        searchChunksRef.current,
        SEARCH_RESULT_LIMIT,
      ).then(setSemanticHits);
    }, 350);
    return () => clearTimeout(timer);
  }, [searchOpen, searchQuery, embedder, engine, db]);

  const bigramHits = useMemo(() => {
    if (!searchOpen || searchIndexRef.current === null) {
      return [];
    }
    return searchChunks(searchIndexRef.current, searchQuery).slice(0, SEARCH_RESULT_LIMIT);
  }, [searchOpen, searchQuery, searchIndexVersion]);
  // 全文ヒットと重複しない「意味が近い」補足
  const extraSemantic = useMemo(() => {
    const seen = new Set(bigramHits.map((h) => h.id));
    return semanticHits.filter((h) => !seen.has(h.id)).slice(0, MAX_SEMANTIC_EXTRA);
  }, [bigramHits, semanticHits]);
  const queryDisplay = useMemo(() => convertRomaji(searchQuery), [searchQuery]);

  return {
    searchOpen,
    searchQuery,
    openSearch,
    handleSearchKey,
    bigramHits,
    extraSemantic,
    queryDisplay,
  };
}
