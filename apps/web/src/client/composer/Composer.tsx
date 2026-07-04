import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { makeTitle } from "@zakki/core/chunk/chunker.ts";
import { ConversionPipeline } from "@zakki/core/conversion/pipeline.ts";
import { stripPasteMarkers, wrapPaste } from "@zakki/core/conversion/paste.ts";
import { segmentKana } from "@zakki/core/conversion/segment.ts";
import {
  freezeLiveTail,
  liveTailStart,
  parseBlocks,
  replaceBlock,
} from "@zakki/core/entry/records.ts";
import { applyKey } from "@zakki/core/input/controller.ts";
import { createEditorStore } from "@zakki/core/input/store.ts";
import { convertRomaji } from "@zakki/core/romaji/convert.ts";
import { api } from "@zakki/web/client/api/client.ts";
import { chunkWeb } from "@zakki/web/client/chunk/chunk.web.ts";
import { remoteEngine } from "@zakki/web/client/composer/remote-engine.ts";
import { toKeyLike } from "@zakki/web/client/composer/web-keys.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";
import { useSessionStore } from "@zakki/web/client/store/session.ts";

/** キーストローク単位の永続化（TUI と同じ間合い, apps/tui/src/tui/App.tsx） */
const SAVE_DEBOUNCE_MS = 300;
/** 保存後、サーバ解析（2s デバウンス）の反映を拾ってグラフを再読込するまでの猶予 */
const GRAPH_RELOAD_MS = 4000;

type SaveState = "saved" | "dirty" | "error";

/** 確定チャンク（凍結リテラル）の修正状態。web はネイティブ input のキャレットを使う */
interface WebEditing {
  start: number;
  end: number;
  text: string;
  old: string;
}

interface ComposerProps {
  sessionId: number;
  initialRaw: string;
  /** ConversionPipeline のシード（サーバの conversion/state から） */
  corrections: ReadonlyMap<string, string>;
  conversionCache: ReadonlyMap<string, string>;
}

/**
 * Composer.Web（docs/COMPOSER.md）: raw 正本・凍結リテラルモデルは TUI と同一で、
 * 変換だけ RemoteEngine（サーバの anco）に委ねる。入力ゲート:
 * - ASCII 打鍵 → applyKey（ローマ字ログ）
 * - IME（compositionend）・ペースト → wrapPaste で凍結リテラル直行（docs/RECORDS.md）
 */
export function Composer({ sessionId, initialRaw, corrections, conversionCache }: ComposerProps) {
  const [store] = useState(() =>
    createEditorStore({
      raw: initialRaw,
      cursor: { pane: "main", index: 0, mode: "input" },
    }),
  );
  const raw = useStore(store, (s) => s.raw);
  const conversionVersion = useStore(store, (s) => s.conversionVersion);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<WebEditing | null>(null);
  const [focused, setFocused] = useState(false);
  const refreshRelated = useSessionStore((s) => s.refreshRelated);
  const reloadGraph = useGraphStore((s) => s.load);
  const graphReloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  const { setRaw, bumpConversion: bump } = store.getState();

  const pipeline = useMemo(
    () =>
      new ConversionPipeline(remoteEngine, bump, (m) => setMessage(`変換エラー: ${m}`), {
        corrections,
        cache: conversionCache,
        onConverted: (kana, conv) => {
          void api.saveConversion(kana, conv).catch(() => {});
        },
      }),
    [corrections, conversionCache, bump],
  );

  /** raw（凍結リテラル込み）を確定テキストへ変換する（保存・凍結判定で共有） */
  const convertRaw = useCallback(
    (input: string, flush = false) => {
      const applied = pipeline.apply(convertRomaji(input, { flush }).converted);
      return { text: stripPasteMarkers(applied.text), converting: applied.converting };
    },
    [pipeline],
  );

  const convertSettled = useCallback(
    (sentenceRomaji: string) => {
      const { text, converting } = convertRaw(sentenceRomaji, true);
      return { text, settled: converting === 0 };
    },
    [convertRaw],
  );

  // Tab: 直前の変換単位の候補ローテーション（選択はサーバの corrections に学習）
  const rotateLastSegment = useCallback(() => {
    const kana = convertRomaji(store.getState().raw).converted;
    const target = segmentKana(kana)
      .filter((s) => s.complete && !s.separator)
      .at(-1);
    if (target === undefined) return;
    pipeline.rotate(target.text, (chosen) => {
      void api.saveCorrection(target.text, chosen).catch(() => setMessage("学習の保存に失敗"));
    });
  }, [pipeline, store]);

  // 追記入力（ゲート通過後の ASCII 打鍵）
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing !== null) return; // 修正中はネイティブ input に任せる
      const key = toKeyLike(e.nativeEvent);
      if (key === null) return;
      if (key.ctrl || key.meta) return; // ブラウザのショートカットを妨げない
      e.preventDefault();
      const action = applyKey(store.getState().raw, key);
      if (action.type === "edit") {
        setRaw(action.raw);
        setSaveState("dirty");
      } else if (action.type === "rotate") {
        rotateLastSegment();
      }
      // open-search / exit は TUI 専用（web ではブラウザ機能に任せる）
    },
    [editing, store, setRaw, rotateLastSegment],
  );

  // IME 確定・ペースト → 凍結リテラル直行（打鍵ペースト扱い, docs/RECORDS.md）
  const appendLiteral = useCallback(
    (text: string) => {
      if (text === "") return;
      setRaw(store.getState().raw + wrapPaste(text));
      setSaveState("dirty");
    },
    [store, setRaw],
  );

  // 保存: 300ms デバウンスで凍結 → 変換 → PUT（TUI の保存 effect の移植）
  useEffect(() => {
    const timer = setTimeout(() => {
      const frozen = freezeLiveTail(store.getState().raw, convertSettled);
      if (frozen.changed) {
        setRaw(frozen.raw);
      }
      const current = store.getState().raw;
      const converted = convertRaw(current).text;
      api
        .saveEntry(sessionId, current, converted)
        .then(() => {
          setSaveState("saved");
          void refreshRelated();
          // サーバ解析（2s デバウンス）の完了を見込んでグラフを再読込
          if (graphReloadTimer.current !== null) clearTimeout(graphReloadTimer.current);
          graphReloadTimer.current = setTimeout(() => void reloadGraph(), GRAPH_RELOAD_MS);
        })
        .catch((e: unknown) => {
          setSaveState("error");
          setMessage(e instanceof Error ? e.message : String(e));
        });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    raw,
    conversionVersion,
    sessionId,
    store,
    setRaw,
    convertRaw,
    convertSettled,
    refreshRelated,
    reloadGraph,
  ]);

  // 修正モード（確定チャンククリック）: ネイティブ input で編集し、Enter/blur で replaceBlock
  const openEdit = useCallback((block: { start: number; end: number; text: string }) => {
    setEditing({ start: block.start, end: block.end, text: block.text, old: block.text });
  }, []);

  useEffect(() => {
    if (editing !== null) {
      editInputRef.current?.focus();
    }
  }, [editing]);

  const commitEdit = useCallback(() => {
    if (editing === null) return;
    // 空のまま確定は元に戻す（削除しない, docs/PANES.md §5）
    const text = editing.text.trim() === "" ? editing.old : editing.text;
    setRaw(replaceBlock(store.getState().raw, editing.start, editing.end, text));
    setEditing(null);
    setSaveState("dirty");
  }, [editing, store, setRaw]);

  const deleteChunk = useCallback(
    (block: { start: number; end: number }) => {
      setRaw(replaceBlock(store.getState().raw, block.start, block.end, ""));
      setEditing(null);
      setSaveState("dirty");
    },
    [store, setRaw],
  );

  // 表示: 凍結チャンク列 + ライブ末尾（変換済み + pending ローマ字）
  const frozen = useMemo(() => parseBlocks(raw).filter((b) => b.frozen), [raw]);
  const live = useMemo(() => {
    const liveRaw = raw.slice(liveTailStart(raw));
    const { converted, pending } = convertRomaji(liveRaw);
    const applied = pipeline.apply(converted);
    return { text: applied.text, pending };
    // conversionVersion: 非同期変換の確定で再計算する
  }, [raw, conversionVersion, pipeline]);

  return (
    <div
      className={focused ? "composer composer--focused" : "composer"}
      tabIndex={0}
      role="textbox"
      aria-label="ジャーナル入力"
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onCompositionEnd={(e) => appendLiteral(e.data)}
      onPaste={(e) => {
        e.preventDefault();
        appendLiteral(e.clipboardData.getData("text/plain"));
      }}
    >
      {frozen.map((block, i) =>
        editing !== null && editing.start === block.start ? (
          <input
            key={`edit-${block.start}`}
            ref={editInputRef}
            className="composer__edit"
            value={editing.text}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") setEditing(null);
            }}
            onBlur={commitEdit}
          />
        ) : (
          <div
            key={`${block.start}-${i}`}
            className={chunkWeb.base}
            title={makeTitle(block.text)}
            onClick={() => openEdit(block)}
          >
            {block.text}
            <button
              type="button"
              className="composer__delete"
              aria-label="このチャンクを削除"
              onClick={(e) => {
                e.stopPropagation();
                deleteChunk(block);
              }}
            >
              ✕
            </button>
          </div>
        ),
      )}
      <div className={`${chunkWeb.base} composer__live`}>
        {live.text}
        <span className={chunkWeb.pending}>{live.pending}</span>
        <span className="composer__caret" />
      </div>
      <div className="composer__status">
        {saveState === "saved" ? "保存済み" : saveState === "dirty" ? "…" : `エラー: ${message}`}
        {message !== "" && saveState !== "error" && ` / ${message}`}
      </div>
    </div>
  );
}
