# サイドバー下部のユーザーメニュー統合（設計・実装メモ）

- 作成: 2026-09-20
- 目的: issue #159 の続き。ログイン前後のサイドバー下部フッターを**単一ボタン**に統一し、
  未ログインを「ローカルユーザ」として表示し、クリックメニューに設定項目と
  ログイン / ログアウトを出す。
- 名称: メニューは設定に加えてログイン / ログアウトも含むため、既存 `AccountMenu` の
  延長ではなく `UserMenu` にした（settings-only ではない）。
- データの扱い（ローカルデータはローカルのみ保持・ログイン時のみサーバ永続化）は
  別 issue #163 に切り出し。本ドキュメントでは概要のみ。

## ゴール（UI）

- 未ログイン（ローカルユーザ）: フッター左下のボタンは**1 つだけ**。文言は「ローカルユーザ」。
  クリックでポップアップメニューを開き、そこに設定項目と「ログイン」を出す。
- ログイン中: アカウント表示（email + プロバイダ名）のボタンは**1 つだけ**。
  クリックでポップアップメニューを開き、そこに設定項目と「ログアウト」を出す。
- ボタン右下の三角（caret, 旧 `account-menu__caret` の `▼/▲`）は、設定を示す
  **歯車アイコン（⚙）**に置き換える。
- サイドバー折り畳み時は従来どおりフッターごと非表示。

## 実装（完了）

- `apps/web/src/client/layout/UserMenu.tsx`（新規）: `AccountMenu.tsx` と
  `LoginButton.tsx` を統合。props は `{ account: AccountInfo | null }`。
  - トリガー: signed-in は「`{providerName} でログイン中` + email + ⚙」、
    それ以外は「ローカルユーザ + ⚙」。⚙ は `user-menu__icon`（`ml-auto` で右下）。
  - メニュー（`role=menu`、透過 backdrop で外側クリック閉じ）:
    - 共通: `⚙ 設定`（`openSettings()` → SettingsPanel モーダル）
    - signed-in: `ログアウト`（auth ストアの `logout()`）
    - signed-out（マルチユーザ）: プロバイダ別 `{provider.name} でログイン`
      （`provider.loginUrl` へ `window.location.assign`。旧 `LoginButton` の実装を移設）
    - `signedOut.error`（`describeError`）はメニュー内 `user-menu__note` に表示
    - 単一ユーザ（`signedOut === null`）: 設定のみ
- `apps/web/src/client/layout/LeftSidebar.tsx`: フッターを `<UserMenu account={account} />`
  の 1 つだけに簡素化（`LoginButton` + ⚙ 設定ボタンの 2 公開を廃止）。
- `apps/web/src/client/layout/LoginButton.tsx` / `AccountMenu.tsx`: 削除。
- `apps/web/src/client/styles.css`: `account-menu__*` を `user-menu__*` へ改名。
  caret → `user-menu__icon`（⚙）、`user-menu__note`（ログインエラー文言）を追加。
- `apps/web/src/client/store/auth.ts`: コメント更新のみ（状態は無変更）。

## 調査メモ（現在の 3 状態と供給源）

- signed-in（マルチユーザ）: `resolveRemoteSession` が signed-in を返し（`main.tsx:45-61`）、
  `account = {email, provider*, userId}` を auth ストアへ。ログアウトは登録 handler
  （client.logout → db.remove → reload）
- signed-out（マルチユーザ）: `signedOut = {providers, error}`（`main.tsx:33-35`）
- 単一ユーザ（controlPlaneUrl null）: `resolveRemoteSession` が null を返す
  （`api/control-plane.ts:289`）→ `signedOut` / `account` とも null

## データの扱い（別 issue #163）

「ローカルデータは IndexedDB にのみ保持し、アカウント ログインを行って初めてサーバへ
永続化する」。現状は「マルチユーザでは 401 で止まるだけ・単一ユーザではローカルサーバ
DB へ同期されてしまう」ため、ローカルのみ保証の実装は #163 へ。設計判断を要する論点:

- 単一ユーザ self-host での「ローカル = 同期しない」の意味（従来はサーバ DB が本尊）
- ログアウト後にローカル DB（`zakki-guest` など）を消す/残す
- E2E 暗号 OFF/ON と replication 開始条件（`db/bootstrap.ts:9-14`）の整理