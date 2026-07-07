import { useCallback, useState, type ReactNode } from "react";
import type { KeyLike } from "@zakki/core/input/controller.ts";
import { applyDialogKey, applyMenuKey } from "@zakki/core/input/controller.ts";

/**
 * モーダル（確認・メニュー）の表示コンポーネントと状態フック（docs/PANES.md §6）。
 *
 * キーの解釈は純粋関数（confirm は applyDialogKey、menu は applyMenuKey、ともに
 * controller.ts）に委ね、状態遷移だけを useModals が担う。App は handleModalKey を
 * 他の全キー処理に優先して呼ぶ。コンポーネント本体は描画だけを担う（汎用・再利用可能）。
 *
 * 配置方式: オーバーレイ。OpenTUI は position:"absolute" / top・left・right・bottom /
 * zIndex / border・borderStyle・backgroundColor を style で受けられる（型定義で確認）ため、
 * 画面全体に半透明風の遮蔽ボックスを敷き、その中央に枠線つきモーダルを重ねる。
 */

interface ConfirmState {
  message: string;
  onConfirm: () => void;
}

interface MenuItem {
  label: string;
  onChoose: () => void;
}

interface MenuState {
  items: MenuItem[];
  index: number;
}

/**
 * 確認ダイアログ・メニューの状態と、モーダル表示中のキー処理（issue #57 で App.tsx から
 * 切り出し）。確認とメニューは同列で、どちらか一方のみ開く（docs/PANES.md §6）。
 */
export function useModals() {
  // 確認ダイアログ（破壊的操作の確認）。null なら非表示。最小形 { message, onConfirm } で
  // 持ち、将来の確認操作も同じ仕組みを再利用する。
  const [dialog, setDialog] = useState<ConfirmState | null>(null);
  // メニューダイアログ（操作の選択）。null なら非表示。各項目は { label, onChoose }。
  const [menu, setMenu] = useState<MenuState | null>(null);

  const openConfirm = useCallback((message: string, onConfirm: () => void) => {
    setDialog({ message, onConfirm });
  }, []);
  const openMenu = useCallback((items: MenuItem[]) => {
    setMenu({ items, index: 0 });
  }, []);

  /** モーダル表示中のキーを処理する。true なら消費済み（呼び出し側は以降の処理をスキップ） */
  const handleModalKey = useCallback(
    (keyEvent: KeyLike): boolean => {
      // メニュー表示中は他の全キー処理に優先して握りつぶす（docs/PANES.md §6）
      if (menu !== null) {
        const a = applyMenuKey(menu.index, keyEvent, menu.items.length);
        if (a.type === "move") {
          setMenu({ ...menu, index: a.index });
        } else if (a.type === "choose") {
          const item = menu.items[menu.index];
          setMenu(null);
          item?.onChoose();
        } else if (a.type === "cancel") {
          setMenu(null);
        }
        return true;
      }
      // 確認ダイアログ表示中も同様に最優先で握りつぶす（docs/PANES.md §6）
      if (dialog !== null) {
        const action = applyDialogKey(keyEvent);
        if (action === "confirm") {
          dialog.onConfirm();
          setDialog(null);
        } else if (action === "cancel") {
          setDialog(null);
        }
        return true;
      }
      return false;
    },
    [menu, dialog],
  );

  return {
    dialog,
    menu,
    openConfirm,
    openMenu,
    handleModalKey,
    modalOpen: dialog !== null || menu !== null,
  };
}

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
