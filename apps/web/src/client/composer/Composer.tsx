import { useCallback, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { chunkText, makeTitle } from "@zakki/core/chunk/chunker.ts";
import { errorMessage } from "@zakki/core/util/error.ts";
import { SAVE_DEBOUNCE_MS } from "@zakki/core/config/timing.ts";
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
import type { ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { docId, numId } from "@zakki/web/client/db/ids.ts";
import { addLinkDocs, saveChildrenDocs, upsertCorrection } from "@zakki/web/client/db/writes.ts";
import { currentHref } from "@zakki/web/client/router/history.ts";
import { selectNode } from "@zakki/web/client/router/navigate.ts";
import { parseRoute } from "@zakki/web/client/router/route.ts";

type SaveState = "saved" | "dirty" | "error";

interface ComposerProps {
  /** 保存先のローカル RxDB（#44）。replication が非同期にサーバへ反映する */
  db: ZakkiDatabase;
  /** 現在のバッファ（親チャンク）の id = 子チャンクの保存先（docs/CHUNKS.md §入力・保存） */
  parentId: number;
  initialRaw: string;
  /** ロード時点の既存チャンク id（初回保存で全チャンクが「新規」扱いになるのを防ぐ） */
  initialChunkIds: readonly number[];
  /** ConversionPipeline のシード（corrections はローカル RxDB・cache はサーバから） */
  corrections: ReadonlyMap<string, string>;
  conversionCache: ReadonlyMap<string, string>;
}

/**
 * Composer.Web（docs/COMPOSER.md）: raw 正本・凍結リテラルモデルは TUI と同一で、
 * 変換だけ RemoteEngine（サーバの anco）に委ねる。入力ゲート:
 * - ASCII 打鍵 → applyKey（ローマ字ログ）
 * - IME（compositionend）・ペースト → wrapPaste で凍結リテラル直行（docs/RECORDS.md）
 *
 * 保存は effect で state を監視せず、入力イベント（と変換の onUpdate）から
 * デバウンス保存関数を直接叩く（issue #52。useEffect なし）。
 *
 * docs の「PC 判定（UA）」ゲートは未実装（スコープ判断）: モバイルの仮想キーボードは
 * ほぼ composition イベント経由で入力されるため上記 2 ルートで吸収できる。物理キーボード
 * 接続のモバイル等で挙動を分けたくなったら UA 判定を足す。
 */
export function Composer({
  db,
  parentId,
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
  // 自動リンク（数珠繋ぎ）の「新規」判定基準。保存応答のたびに更新する
  const knownChunkIds = useRef<readonly number[]>(initialChunkIds);

  // 新規チャンクを「選択中の投稿」（URL の ?select=）から数珠繋ぎに自動リンクし、
  // 選択を最新へ移す。リンクは links コレクションへ永続化し（#77）、グラフへは
  // liveQuery 購読で反映される（replication が非同期にサーバへ push する）
  const linkNewChunks = useCallback(
    (savedChunks: readonly { id: number }[]) => {
      const fresh = newChunkIds(knownChunkIds.current, savedChunks);
      knownChunkIds.current = savedChunks.map((c) => c.id);
      if (fresh.length === 0) return;
      const anchor = parseRoute(currentHref()).select;
      void addLinkDocs(db, chainLinks(anchor, fresh)).catch((e: unknown) => {
        setMessage(`リンクの保存に失敗: ${errorMessage(e)}`);
      });
      selectNode(fresh.at(-1) ?? null);
    },
    [db],
  );

  const { setRaw, setEditing, bumpConversion: bump } = store.getState();

  // 保存: 300ms デバウンスで凍結 → 変換 → ローカル RxDB へ投影（#44）。
  // グラフは liveQuery 購読で自動反映されるため楽観的更新は不要。
  // サーバへは replication が非同期に push する。呼び出し元は入力イベントハンドラと
  // 変換の onUpdate（非同期変換の確定・候補ローテーション）。バッファ切替で
  // アンマウントされても保留中の保存はそのまま走らせ、直前の入力を失わない。
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversionRef = useRef<ReturnType<typeof createConversionSession> | null>(null);
  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const session = conversionRef.current;
      if (session === null) return;
      const frozen = freezeLiveTail(store.getState().raw, session.convertSettled);
      if (frozen.changed) {
        setRaw(frozen.raw);
      }
      const converted = session.convertRaw(store.getState().raw).text;
      saveChildrenDocs(db, docId(parentId), chunkText(converted))
        .then((saved) => {
          setSaveState("saved");
          linkNewChunks(saved.map((c) => ({ id: numId(c.id) })));
        })
        .catch((e: unknown) => {
          setSaveState("error");
          setMessage(errorMessage(e));
        });
    }, SAVE_DEBOUNCE_MS);
  }, [store, setRaw, db, parentId, linkNewChunks]);

  // 変換合成（機能ロジック）は core と共有し、副作用（永続化・エラー表示・再保存）だけ注入する
  const conversion = useMemo(
    () =>
      createConversionSession(remoteEngine, {
        corrections,
        cache: conversionCache,
        onUpdate: () => {
          bump();
          scheduleSave();
        },
        onError: (m) => setMessage(`変換エラー: ${m}`),
        onConverted: (kana, conv) => {
          void api.saveConversion(kana, conv).catch(() => setMessage("変換キャッシュの保存に失敗"));
        },
        onChosen: (kana, chosen) => {
          void upsertCorrection(db, kana, chosen).catch(() => setMessage("学習の保存に失敗"));
        },
      }),
    [corrections, conversionCache, bump, scheduleSave, db],
  );
  conversionRef.current = conversion;

  // raw の編集（＝保存対象の変化）を一手に引き受け、dirty 表示とデバウンス保存を駆動する
  const editRaw = useCallback(
    (next: string) => {
      setRaw(next);
      setSaveState("dirty");
      scheduleSave();
    },
    [setRaw, scheduleSave],
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
        editRaw(action.raw);
      } else if (action.type === "rotate") {
        conversion.rotateLastSegment(store.getState().raw); // 保存は onUpdate 経由
      }
      // open-search / exit は TUI 専用（web ではブラウザ機能に任せる）
    },
    [store, editRaw, conversion],
  );

  // IME 確定・ペースト → 凍結リテラル直行（打鍵ペースト扱い, docs/RECORDS.md）
  const appendLiteral = useCallback(
    (text: string) => {
      if (text === "") return;
      editRaw(store.getState().raw + wrapPaste(text));
    },
    [store, editRaw],
  );

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

  const commitEdit = useCallback(() => {
    const current = store.getState().editing;
    if (current === null || current.target.kind !== "main") return;
    // 空のまま確定は元に戻す（削除しない, docs/PANES.md §5）
    const text = current.text.trim() === "" ? current.old : current.text;
    editRaw(replaceBlock(store.getState().raw, current.target.start, current.target.end, text));
    setEditing(null);
  }, [store, editRaw, setEditing]);

  const deleteChunk = useCallback(
    (block: { start: number; end: number }) => {
      editRaw(replaceBlock(store.getState().raw, block.start, block.end, ""));
      setEditing(null);
    },
    [store, editRaw, setEditing],
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
            className="composer__edit"
            value={editing.text}
            autoFocus
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
