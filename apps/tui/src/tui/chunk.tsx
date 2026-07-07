import type { Ref } from "react";
import type { ReactNode } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ChunkPresentation } from "@zakki/core/chunk/presentation.ts";
import { makeTitle } from "@zakki/core/chunk/chunker.ts";

/**
 * Chunk.tui（docs/COMPOSER.md）: 値は opentui の fg 色。web 側
 * （`chunk.web.ts` の CSS 意味クラス）と同じ契約（ChunkPresentation）に通す
 * （issue #58 項目 12。cell と px で実値は別物のため色そのものは共有しない）。
 */
const chunkTui: ChunkPresentation<string> = {
  base: "#cccccc",
  selected: "#ffffff",
  pending: "#777777",
};

/** 関連リスト項目（Digest）の色。ChunkPresentation の外側の TUI 固有補助（web の chunkDigestWeb と対） */
const chunkDigestTui = {
  base: "#aaaaaa",
  date: "#88aaff",
} as const;

// カーソルはグリフではなく端末ネイティブの縦棒で描く（src/tui/native-cursor.ts）。
// セル境界に置かれるので前後の文字との隙間が出ない（useBarCursor が位置を制御）。

/**
 * メイン入力・修正・検索で共有する読み取り用スクロール面。
 * scrollbox の設定（右余白・末尾スティック・フォーカス）を一元化する。
 */
function Surface({
  focused = false,
  stickyBottom = false,
  scrollRef,
  children,
}: {
  focused?: boolean;
  stickyBottom?: boolean;
  /** カーソル追従スクロール（scrollChildIntoView）用に ScrollBox 実体を受け取る */
  scrollRef?: Ref<ScrollBoxRenderable>;
  children: ReactNode;
}) {
  return (
    <scrollbox
      ref={scrollRef}
      // minHeight:0 で flex 親内でも内容に膨らまず、はみ出さずスクロールできる
      style={{ flexGrow: 1, minHeight: 0 }}
      focused={focused}
      stickyScroll={stickyBottom}
      stickyStart={stickyBottom ? "bottom" : undefined}
      // 動的に追加した子（確定でできたチャンク）が描画されないのを防ぐためカリング無効。
      // 1 日ぶんの有界なチャンク数なので性能影響はない。
      viewportCulling={false}
      // スクロールバーが本文右端の文字に被らないよう、本文側に 1 桁の余白を確保する
      contentOptions={{ paddingRight: 1 }}
    >
      {children}
    </scrollbox>
  );
}

/** 1 行のヘッダ／フッタ（修正前表示・操作ヒント等） */
function Status({ fg = "#888888", children }: { fg?: string; children: ReactNode }) {
  return (
    <box style={{ height: 1 }}>
      <text style={{ fg }}>{children}</text>
    </box>
  );
}

/**
 * 末尾の新規入力（追記専用）。末尾にネイティブ縦棒カーソルが置かれる（useBarCursor）。
 * pending（打鍵途中ローマ字）を末尾に淡色で添える。
 */
function New({
  text,
  pending = "",
  id,
  onClick,
}: {
  text: string;
  pending?: string;
  /** 追従スクロール・カーソル位置算出の対象にするための要素 id（任意） */
  id?: string;
  onClick?: () => void;
}) {
  return (
    <box id={id} onMouseDown={onClick}>
      <text style={{ wrapMode: "word" }}>
        {text}
        <span fg={chunkTui.pending}>{pending}</span>
      </text>
    </box>
  );
}

/**
 * 確定チャンクの修正（プレーン編集）。テキストはそのまま描き、カーソルは
 * ネイティブ縦棒で重ねて描く（位置は useBarCursor が editing.cursor から算出する）。
 */
function Edit({ text }: { text: string }) {
  return <text style={{ wrapMode: "word" }}>{text}</text>;
}

/**
 * 確定チャンク 1 行の表示（1 チャンク 1 行）。クリックで起動する。
 * 選択中は fg を明るくして強調する（左ガター記号は使わない）。
 */
function View({
  text,
  selected = false,
  id,
  onClick,
}: {
  text: string;
  selected?: boolean;
  /** 追従スクロールの対象にするための要素 id（任意） */
  id?: string;
  onClick?: () => void;
}) {
  return (
    <box id={id} onMouseDown={onClick}>
      <text style={{ fg: selected ? chunkTui.selected : chunkTui.base, wrapMode: "word" }}>
        {text}
      </text>
    </box>
  );
}

/**
 * 関連リスト項目の表示（日付＋本文タイトル）。クリックで起動する。
 * 選択中は fg を明るくして強調する（従来の active 判定と同じ白／灰の見た目）。
 */
function Digest({
  date,
  content,
  selected = false,
  onClick,
}: {
  date: string;
  content: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <box onMouseDown={onClick}>
      <text style={{ fg: selected ? chunkTui.selected : chunkDigestTui.base, wrapMode: "char" }}>
        <span fg={chunkDigestTui.date}>{date}</span> {makeTitle(content)}
      </text>
    </box>
  );
}

/**
 * チャンク 1 個の全表現を集約したコンパウンドコンポーネント。
 * 確定表示（View）・要約（Digest）・修正（Edit）・新規入力（New）を同じ系統に通し、
 * スクロール面（Surface）と 1 行ヘッダ／フッタ（Status）をレイアウト補助として持つ。
 */
export const Chunk = {
  New,
  Edit,
  View,
  Digest,
  Surface,
  Status,
};
