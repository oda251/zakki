import type { ReactNode } from "react";

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
  children,
}: {
  focused?: boolean;
  stickyBottom?: boolean;
  children: ReactNode;
}) {
  return (
    <scrollbox
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
 * テキスト＋カーソルを描く本文。2 つのモードを同じ表示面で扱う:
 * - new（追記専用）: 末尾にカーソル。pending（打鍵途中ローマ字）を添える。
 * - edit（可動カーソル）: cursor 位置でテキストを分割し、その間にカーソルを置く。
 */
function Field({
  text,
  variant,
  pending = "",
  cursor = text.length,
}: {
  text: string;
  /** new = 追記専用（末尾カーソル） / edit = 可動カーソル（プレーン編集） */
  variant: "new" | "edit";
  /** new のみ: 打鍵途中ローマ字（カーソル直前に淡色で表示） */
  pending?: string;
  /** edit のみ: カーソル位置 [0, text.length] */
  cursor?: number;
}) {
  if (variant === "new") {
    return (
      <text style={{ wrapMode: "word" }}>
        {text}
        <span fg={PENDING_FG}>{pending}</span>
        <span fg={CURSOR_FG}>{CURSOR_GLYPH}</span>
      </text>
    );
  }
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
 * 入力面のコンパウンドコンポーネント（root + サブコンポーネント）。
 * メイン入力（new）と確定チャンク修正（edit）の両方が同じ Editor 系統を通る。
 */
export const Editor = {
  Surface,
  Field,
  Status,
};
