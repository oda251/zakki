import { useCallback, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { chunkText, makeTitle } from "@zakki/core/chunk/chunker.ts";
import { errorMessage } from "@zakki/core/util/error.ts";
import { SAVE_DEBOUNCE_MS } from "@zakki/core/config/timing.ts";
import { createConversionSession } from "@zakki/core/conversion/compose.ts";
import type { KanaKanjiEngine } from "@zakki/core/conversion/engine.ts";
import {
  commitLine,
  freezeLiveTail,
  replaceBlock,
  splitDisplay,
  withDraft,
} from "@zakki/core/entry/records.ts";
import { createEditorStore } from "@zakki/core/input/store.ts";
import { chunkWeb } from "@zakki/web/client/chunk/chunk.web.ts";
import { newChunkIds, planAutoLink } from "@zakki/web/client/composer/auto-link.ts";
import type { ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { docId, numId } from "@zakki/web/client/db/ids.ts";
import { addLinkDocs, saveChildrenDocs, upsertCorrection } from "@zakki/web/client/db/writes.ts";
import { currentHref } from "@zakki/web/client/router/history.ts";
import { selectNode } from "@zakki/web/client/router/navigate.ts";
import { parseRoute } from "@zakki/web/client/router/route.ts";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";

type SaveState = "saved" | "dirty" | "error";

interface ComposerProps {
  /** 保存先のローカル RxDB（#44）。replication が非同期にサーバへ反映する */
  db: ZakkiDatabase;
  /** 現在のバッファ（親チャンク）の id = 子チャンクの保存先（docs/CHUNKS.md §入力・保存） */
  parentId: number;
  initialRaw: string;
  /** ロード時点の既存チャンク id（初回保存で全チャンクが「新規」扱いになるのを防ぐ） */
  initialChunkIds: readonly number[];
  /** ConversionPipeline のシード（corrections はローカル RxDB。#44） */
  corrections: ReadonlyMap<string, string>;
  /** かな漢字変換エンジン。web は identityEngine（変換しない。ComposerPane の注記） */
  engine: KanaKanjiEngine;
}

/**
 * Composer.Web（docs/COMPOSER.md）: raw 正本・凍結リテラルモデルは TUI と同一で、
 * 変換エンジンは注入（web は identityEngine で、漢字は OS の IME に任せる）。
 * 入力はネイティブの textarea（キャレット・IME・ペースト・選択は OS 任せ）で、Enter で
 * その本文を 1 行分の凍結リテラルとして raw に確定する（commitLine。TUI の Enter と同じ区切り）。
 * Shift+Enter は textarea 内の改行（1 チャンクの中の改行）。IME 変換中の Enter は IME のもの。
 * 確定前の下書きも保存対象に含める（withDraft）ので、Enter を押さずに離れても入力を失わない。
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
  engine,
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
  // 自動リンク（数珠繋ぎ）の「新規」判定基準。保存応答のたびに更新する
  const knownChunkIds = useRef<readonly number[]>(initialChunkIds);
  // 未確定の入力（textarea の本文）。保存タイマーからも読むので ref にも持つ
  const [draft, setDraftState] = useState("");
  const draftRef = useRef("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // 履歴（確定チャンク）の表示範囲。既定は最新 2 件だけ（チャット風）。上へスクロール
  // （ホイール・下向きスワイプ）すると全件を出し、欄の高さはウィンドウの高さまで伸びる。
  // 入力を始めたら最新 2 件に戻す
  const [expanded, setExpanded] = useState(false);
  const touchY = useRef<number | null>(null);
  const expandHistory = useCallback(() => {
    if (!expanded) setExpanded(true);
  }, [expanded]);
  const setDraft = useCallback((next: string) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  // 新規チャンクを「選択中の投稿」（保存予約時点の ?select=）から数珠繋ぎに自動リンクし、
  // 選択を最新へ移す。リンクは links コレクションへ永続化し（#77）、グラフへは
  // liveQuery 購読で反映される（replication が非同期にサーバへ push する）。
  // バッファ切替後に後着した保存では planAutoLink が null を返し、切替先への
  // 誤リンク・?select= の誤上書きをしない（保存本体は走らせてデータを保全する）
  const linkNewChunks = useCallback(
    (savedChunks: readonly { id: number }[], anchor: number | null) => {
      const fresh = newChunkIds(knownChunkIds.current, savedChunks);
      knownChunkIds.current = savedChunks.map((c) => c.id);
      const plan = planAutoLink({
        parentId,
        anchor,
        chunk: parseRoute(currentHref()).chunk,
        currentId: useBufferStore.getState().currentId,
        freshIds: fresh,
      });
      if (plan === null) return;
      void addLinkDocs(db, plan.links).catch((e: unknown) => {
        setMessage(`リンクの保存に失敗: ${errorMessage(e)}`);
      });
      selectNode(plan.select);
    },
    [db, parentId],
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
    // アンカー（数珠繋ぎの起点）は予約時点で捕捉する: 発火（300ms 後）までにバッファが
    // 切り替わっても、切替先 URL の ?select= を誤って読まない（PR #79 レビュー対応）
    const anchor = parseRoute(currentHref()).select;
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const session = conversionRef.current;
      if (session === null) return;
      const frozen = freezeLiveTail(store.getState().raw, session.convertSettled);
      if (frozen.changed) {
        setRaw(frozen.raw);
      }
      const converted = session.convertRaw(withDraft(store.getState().raw, draftRef.current)).text;
      saveChildrenDocs(db, docId(parentId), chunkText(converted))
        .then((saved) => {
          setSaveState("saved");
          linkNewChunks(
            saved.map((c) => ({ id: numId(c.id) })),
            anchor,
          );
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
      createConversionSession(engine, {
        corrections,
        onUpdate: () => {
          bump();
          scheduleSave();
        },
        onError: (m) => setMessage(`変換エラー: ${m}`),
        onChosen: (kana, chosen) => {
          void upsertCorrection(db, kana, chosen).catch(() => setMessage("学習の保存に失敗"));
        },
      }),
    [corrections, engine, bump, scheduleSave, db],
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

  // textarea の入力。下書きの変化も保存対象（withDraft）なのでデバウンス保存を回す
  const onDraftChange = useCallback(
    (next: string) => {
      setDraft(next);
      setExpanded(false);
      setSaveState("dirty");
      scheduleSave();
    },
    [setDraft, scheduleSave],
  );

  // Enter で確定（Shift+Enter は改行、IME 変換中の Enter は IME の確定に任せる）
  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
      e.preventDefault();
      editRaw(commitLine(store.getState().raw, draftRef.current));
      setDraft("");
      setExpanded(false);
    },
    [store, editRaw, setDraft],
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

  // 既定は最新 2 件だけ。履歴欄は column-reverse（スクロールの起点が下端＝最新）なので
  // 新しい順に並べて渡す。展開した瞬間も最新が見えたまま、上へ遡っていける
  const visible = (expanded ? frozen : frozen.slice(-2)).toReversed();

  const editingStart =
    editing !== null && editing.target.kind === "main" ? editing.target.start : null;

  return (
    // チャット風: 確定チャンクは吹き出し（最新 2 件、遡ると全件）、その下に入力欄
    <div className="composer">
      <div
        className={expanded ? "composer__history composer__history--expanded" : "composer__history"}
        onWheel={(e) => {
          if (e.deltaY < 0) expandHistory();
        }}
        onTouchStart={(e) => {
          touchY.current = e.touches[0]?.clientY ?? null;
        }}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY;
          // 指を下へ動かす = 上の（過去の）内容を見に行く
          if (touchY.current !== null && y !== undefined && y - touchY.current > 8) expandHistory();
        }}
      >
        {(live.text !== "" || live.pending !== "") && (
          // 以前の打鍵モデルで残った未確定のローマ字（保存時に凍結される）。通常は出ない。
          // column-reverse なので先頭に置く＝最下段に出る
          <div className={`${chunkWeb.base} composer__live`}>
            {live.text}
            <span className={chunkWeb.pending}>{live.pending}</span>
          </div>
        )}
        {visible.map((block, i) =>
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
      </div>
      <textarea
        ref={inputRef}
        className="composer__input"
        aria-label="ジャーナル入力"
        rows={1}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={onInputKeyDown}
      />
      <div className="composer__status">
        {saveState === "saved" ? "保存済み" : saveState === "dirty" ? "…" : `エラー: ${message}`}
        {message !== "" && saveState !== "error" && ` / ${message}`}
      </div>
    </div>
  );
}
