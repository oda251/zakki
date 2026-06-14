import type { Ref } from "react";
import type { ReactNode } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { makeTitle } from "@/chunk/chunker.ts";

/** カーソル字形と打鍵途中ローマ字の色（App の従来表示に合わせる） */
const CURSOR_GLYPH = "▌";
const CURSOR_FG = "#aaaaaa";
const PENDING_FG = "#777777";

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
 * 末尾の新規入力（追記専用）。末尾にカーソルを置き、
 * pending（打鍵途中ローマ字）をカーソル直前に淡色で添える。
 */
function New({
  text,
  pending = "",
  id,
  onClick,
}: {
  text: string;
  pending?: string;
  /** 追従スクロールの対象にするための要素 id（任意） */
  id?: string;
  onClick?: () => void;
}) {
  return (
    <box id={id} onMouseDown={onClick}>
      <text style={{ wrapMode: "word" }}>
        {text}
        <span fg={PENDING_FG}>{pending}</span>
        <span fg={CURSOR_FG}>{CURSOR_GLYPH}</span>
      </text>
    </box>
  );
}

/**
 * 確定チャンクの修正（可動カーソル）。cursor 位置でテキストを分割し、
 * その間にカーソルを置く（プレーン編集）。
 */
function Edit({ text, cursor }: { text: string; cursor: number }) {
  const at = Math.max(0, Math.min(text.length, cursor));
  return (
    <text style={{ wrapMode: "word" }}>
      {text.slice(0, at)}
      <span fg={CURSOR_FG}>{CURSOR_GLYPH}</span>
      {text.slice(at)}
    </text>
  );
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
      <text style={{ fg: selected ? "#ffffff" : "#cccccc", wrapMode: "word" }}>{text}</text>
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
      <text style={{ fg: selected ? "#ffffff" : "#aaaaaa", wrapMode: "char" }}>
        <span fg="#88aaff">{date}</span> {makeTitle(content)}
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
