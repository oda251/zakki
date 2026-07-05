import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { makeTitle } from "@zakki/core/chunk/chunker.ts";
import { createConversionSession } from "@zakki/core/conversion/compose.ts";
import { wrapPaste } from "@zakki/core/conversion/paste.ts";
import { freezeLiveTail, replaceBlock, splitDisplay } from "@zakki/core/entry/records.ts";
import { applyKey } from "@zakki/core/input/controller.ts";
import { createEditorStore } from "@zakki/core/input/store.ts";
import { api } from "@zakki/web/client/api/client.ts";
import { chunkWeb } from "@zakki/web/client/chunk/chunk.web.ts";
import { chainLinks, newChunkIds } from "@zakki/web/client/composer/auto-link.ts";
import { remoteEngine } from "@zakki/web/client/composer/remote-engine.ts";
import { toKeyLike } from "@zakki/web/client/composer/web-keys.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";
import { useSessionStore } from "@zakki/web/client/store/session.ts";

/** キーストローク単位の永続化（TUI と同じ間合い, apps/tui/src/tui/App.tsx） */
const SAVE_DEBOUNCE_MS = 300;
/** 保存後、サーバ解析（2s デバウンス）の反映を拾って関連・グラフを更新するまでの猶予 */
const AMBIENT_REFRESH_MS = 4000;

type SaveState = "saved" | "dirty" | "error";

interface ComposerProps {
  sessionId: number;
  initialRaw: string;
  /** ロード時点の既存チャンク id（初回保存で全チャンクが「新規」扱いになるのを防ぐ） */
  initialChunkIds: readonly number[];
  /** ConversionPipeline のシード（サーバの conversion/state から） */
  corrections: ReadonlyMap<string, string>;
  conversionCache: ReadonlyMap<string, string>;
}

/**
 * Composer.Web（docs/COMPOSER.md）: raw 正本・凍結リテラルモデルは TUI と同一で、
 * 変換だけ RemoteEngine（サーバの anco）に委ねる。入力ゲート:
 * - ASCII 打鍵 → applyKey（ローマ字ログ）
 * - IME（compositionend）・ペースト → wrapPaste で凍結リテラル直行（docs/RECORDS.md）
 *
 * docs の「PC 判定（UA）」ゲートは未実装（スコープ判断）: モバイルの仮想キーボードは
 * ほぼ composition イベント経由で入力されるため上記 2 ルートで吸収できる。物理キーボード
 * 接続のモバイル等で挙動を分けたくなったら UA 判定を足す。
 */
export function Composer({
  sessionId,
  initialRaw,
  initialChunkIds,
  corrections,
  conversionCache,
}: ComposerProps) {
  const [store] = useState(() =>
    createEditorStore({
      raw: initialRaw,
      cursor: { pane: "main", index: 0, mode: "input" },
    }),
  );
  const raw = useStore(store, (s) => s.raw);
  const conversionVersion = useStore(store, (s) => s.conversionVersion);
  // 確定チャンクの修正（core store の editing を共有。カーソルはネイティブ input が持つ）
  const editing = useStore(store, (s) => s.editing);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [message, setMessage] = useState("");
  const [focused, setFocused] = useState(false);
  const refreshRelated = useSessionStore((s) => s.refreshRelated);
  const reloadGraph = useGraphStore((s) => s.load);
  const ambientTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  // 自動リンク（数珠繋ぎ）の「新規」判定基準。保存応答のたびに更新する
  const knownChunkIds = useRef<readonly number[]>(initialChunkIds);

  // 新規チャンクを「選択中の投稿」から数珠繋ぎに自動リンクし、選択を最新へ移す
  const linkNewChunks = useCallback(async (savedChunks: readonly { id: number }[]) => {
    const fresh = newChunkIds(knownChunkIds.current, savedChunks);
    knownChunkIds.current = savedChunks.map((c) => c.id);
    if (fresh.length === 0) return;
    const anchor = useGraphStore.getState().selectedNodeId;
    await Promise.all(
      chainLinks(anchor, fresh).map((link) =>
        api.addLink(link.from, link.to).catch(() => setMessage("リンク作成に失敗")),
      ),
    );
    useGraphStore.getState().selectNode(fresh.at(-1) ?? null);
  }, []);

  const { setRaw, setEditing, bumpConversion: bump } = store.getState();

  // 変換合成（機能ロジック）は core と共有し、副作用（永続化・エラー表示）だけ注入する
  const conversion = useMemo(
    () =>
      createConversionSession(remoteEngine, {
        corrections,
        cache: conversionCache,
        onUpdate: bump,
        onError: (m) => setMessage(`変換エラー: ${m}`),
        onConverted: (kana, conv) => {
          void api.saveConversion(kana, conv).catch(() => setMessage("変換キャッシュの保存に失敗"));
        },
        onChosen: (kana, chosen) => {
          void api.saveCorrection(kana, chosen).catch(() => setMessage("学習の保存に失敗"));
        },
      }),
    [corrections, conversionCache, bump],
  );

  // 追記入力（ゲート通過後の ASCII 打鍵）
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (store.getState().editing !== null) return; // 修正中はネイティブ input に任せる
      const key = toKeyLike(e.nativeEvent);
      if (key === null) return;
      if (key.ctrl || key.meta) return; // ブラウザのショートカットを妨げない
      e.preventDefault();
      const action = applyKey(store.getState().raw, key);
      if (action.type === "edit") {
        setRaw(action.raw);
        setSaveState("dirty");
      } else if (action.type === "rotate") {
        conversion.rotateLastSegment(store.getState().raw);
      }
      // open-search / exit は TUI 専用（web ではブラウザ機能に任せる）
    },
    [store, setRaw, conversion],
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

  // 保存: 300ms デバウンスで凍結 → 変換 → PUT（TUI の保存 effect の移植）。
  // 関連・グラフの更新はさらに粗い周期（サーバ解析の反映を待つ二段デバウンス）
  useEffect(() => {
    const timer = setTimeout(() => {
      const frozen = freezeLiveTail(store.getState().raw, conversion.convertSettled);
      if (frozen.changed) {
        setRaw(frozen.raw);
      }
      const current = store.getState().raw;
      const converted = conversion.convertRaw(current).text;
      api
        .saveEntry(sessionId, current, converted)
        .then(async (saved) => {
          setSaveState("saved");
          await linkNewChunks(saved.chunks);
          if (ambientTimer.current !== null) clearTimeout(ambientTimer.current);
          ambientTimer.current = setTimeout(() => {
            void refreshRelated();
            void reloadGraph();
          }, AMBIENT_REFRESH_MS);
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
    conversion,
    linkNewChunks,
    refreshRelated,
    reloadGraph,
  ]);

  // 修正モード（確定チャンククリック）: ネイティブ input で編集し、Enter/blur で replaceBlock
  const openEdit = useCallback(
    (block: { start: number; end: number; content: string }) => {
      setEditing({
        target: { kind: "main", start: block.start, end: block.end },
        old: block.content,
        text: block.content,
        cursor: block.content.length,
      });
    },
    [setEditing],
  );

  useEffect(() => {
    if (editing !== null) {
      editInputRef.current?.focus();
    }
  }, [editing]);

  const commitEdit = useCallback(() => {
    const current = store.getState().editing;
    if (current === null || current.target.kind !== "main") return;
    // 空のまま確定は元に戻す（削除しない, docs/PANES.md §5）
    const text = current.text.trim() === "" ? current.old : current.text;
    setRaw(replaceBlock(store.getState().raw, current.target.start, current.target.end, text));
    setEditing(null);
    setSaveState("dirty");
  }, [store, setRaw, setEditing]);

  const deleteChunk = useCallback(
    (block: { start: number; end: number }) => {
      setRaw(replaceBlock(store.getState().raw, block.start, block.end, ""));
      setEditing(null);
      setSaveState("dirty");
    },
    [store, setRaw, setEditing],
  );

  // 表示: 確定チャンク列（行グループ単位、DB チャンクと 1:1）+ ライブ末尾
  // （変換済み + pending ローマ字）。同一行の複数リテラルはここでマージされる
  // ため、凍結リテラル単位（parseBlocks(raw).filter(frozen)）では列挙しない。
  const display = useMemo(() => splitDisplay(raw), [raw]);
  const frozen = display.frozen;
  const live = useMemo(
    () => conversion.convertLive(display.liveRaw),
    [display.liveRaw, conversionVersion, conversion],
  );

  const editingStart =
    editing !== null && editing.target.kind === "main" ? editing.target.start : null;

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
        editingStart === block.start && editing !== null ? (
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
            title={makeTitle(block.content)}
            onClick={() => openEdit(block)}
          >
            {block.content}
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
