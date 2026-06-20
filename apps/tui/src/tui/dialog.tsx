import type { ReactNode } from "react";

/**
 * モーダル（確認・メニュー）の表示専用コンパウンドコンポーネント（docs/PANES.md §6）。
 *
 * キーハンドリングは持たない: 解釈は純粋関数（confirm は applyDialogKey、menu は
 * applyMenuKey、ともに controller.ts）が行い、App がそれを最優先で処理する。
 * 本コンポーネントは描画だけを担う（汎用・再利用可能）。
 *
 * 配置方式: オーバーレイ。OpenTUI は position:"absolute" / top・left・right・bottom /
 * zIndex / border・borderStyle・backgroundColor を style で受けられる（型定義で確認）ため、
 * 画面全体に半透明風の遮蔽ボックスを敷き、その中央に枠線つきモーダルを重ねる。
 */

/** モーダル枠・ラベルの配色（既存 TUI の灰系・Chunk.Status の作法に合わせる） */
const OVERLAY_BG = "#000000";
const MODAL_BG = "#1a1a1a";
const MODAL_BORDER = "#888888";
const MESSAGE_FG = "#ffffff";
const HINT_FG = "#888888";
/** メニューで選択中の項目を強調する色（fg 強調・§ 選択表示に倣う） */
const ITEM_FG = "#cccccc";
const ITEM_SELECTED_FG = "#ffffff";

/**
 * 共有オーバーレイ。画面全体を覆う遮蔽ボックス（zIndex で前面）の中央に、
 * 枠線つきモーダルを重ねる。Confirm / Menu の見た目を一元化する。
 */
function Overlay({ children }: { children: ReactNode }) {
  return (
    <box
      style={{
        // 画面全体を覆うオーバーレイ。zIndex で通常画面の上に重ねる
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 100,
        backgroundColor: OVERLAY_BG,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <box
        style={{
          flexDirection: "column",
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 1,
          paddingBottom: 1,
          border: true,
          borderStyle: "rounded",
          borderColor: MODAL_BORDER,
          backgroundColor: MODAL_BG,
        }}
      >
        {children}
      </box>
    </box>
  );
}

/** 破壊的操作の確認ダイアログ（メッセージ＋確定/取消ヒント） */
function Confirm({
  message,
  confirmLabel = "OK (y)",
  cancelLabel = "Cancel (n)",
}: {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}) {
  return (
    <Overlay>
      <text style={{ fg: MESSAGE_FG, wrapMode: "word" }}>{message}</text>
      <box style={{ height: 1 }} />
      <text style={{ fg: HINT_FG }}>
        {confirmLabel} ｜ {cancelLabel}
      </text>
    </Overlay>
  );
}

/**
 * 操作の選択メニュー（項目リスト＋ハイライト）。index の項目を fg 強調で示す。
 * キーは App が applyMenuKey で処理する（本コンポーネントは表示専用）。
 */
function Menu({
  title,
  items,
  index,
}: {
  title?: string;
  items: { label: string }[];
  index: number;
}) {
  return (
    <Overlay>
      {title !== undefined && (
        <box style={{ marginBottom: 1 }}>
          <text style={{ fg: MESSAGE_FG }}>{title}</text>
        </box>
      )}
      {items.map((item, i) => (
        <text key={item.label} style={{ fg: i === index ? ITEM_SELECTED_FG : ITEM_FG }}>
          {i === index ? "▸ " : "  "}
          {item.label}
        </text>
      ))}
      <box style={{ height: 1 }} />
      <text style={{ fg: HINT_FG }}>↑↓ 選択 ｜ Enter 決定 ｜ Esc 取消</text>
    </Overlay>
  );
}

export const Dialog = { Confirm, Menu };
