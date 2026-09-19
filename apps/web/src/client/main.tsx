import { createRoot } from "react-dom/client";
import { errorMessage } from "@zakki/core/util/error.ts";
import { App } from "@zakki/web/client/App.tsx";
import { connectRouter } from "@zakki/web/client/router/controller.ts";
import { useAuthStore } from "@zakki/web/client/store/auth.ts";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";
import { usePasskeyStore } from "@zakki/web/client/store/passkey.ts";
import "@zakki/web/client/styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("#root が見つかりません");
}
createRoot(root).render(<App />);

// RxDB（Dexie storage）と replication の起動（#43）→ UI 購読の配線（#44）→
// URL ルーティングの配線（#52: URL が SSOT。バッファは URL 変化に追随してロードされ、
// ディープリンク・リロード・戻る/進むもここから復元される）。
// UI はローカルレプリカを liveQuery で読むため、初回同期を待たずに接続してよい。
// RxDB + libsodium が重いため、GraphView と同じく初期チャンクから dynamic import で分離する。
// 構成の選択は設定ベース（#105）: 中継サーバが控えるコントロールプレーン URL があれば
// OIDC ログイン（docs/MULTIUSER.md「ログイン（OIDC）」）の結果を見る。signed-in ならその DB
// （RemoteIdentity）へ、signed-out なら「Google でログイン」を出すためプロバイダ一覧を
// auth ストアへ渡す——どちらもいったんローカルのみで起動し、同期は signed-in のときだけ
// 始まる。単一ユーザ構成（controlPlaneUrl 未設定 = null）も同じくローカルのみで起動する。
void Promise.all([
  import("@zakki/web/client/db/bootstrap.ts"),
  import("@zakki/web/client/api/control-plane.ts").then(async (m) => m.resolveRemoteSession()),
])
  .then(async ([m, remote]) => {
    if (remote?.status === "signed-out") {
      useAuthStore.getState().setSignedOut(remote);
    }
    const { db, passkey } = await m.bootstrapClientDb(
      remote?.status === "signed-in"
        ? { fetchFn: remote.fetchFn, dbName: `zakki-${remote.identity.userId}` }
        : {},
    );
    useGraphStore.getState().connect(db);
    useBufferStore.getState().connect(db);
    // パスキー登録 UI（#104）。DEK は bootstrap のクロージャに閉じたまま渡らない。
    // ログインとは切り離した E2E アンロックなので、OIDC の signed-in/out に関わらず配線する
    usePasskeyStore.getState().connect(passkey);
    connectRouter();
  })
  .catch((err: unknown) => {
    const message = errorMessage(err);
    console.error(`zakki-db: ${message}`);
    useGraphStore.getState().fail(`起動に失敗しました: ${message}`);
  });
