import { createRoot } from "react-dom/client";
import { errorMessage } from "@zakki/core/util/error.ts";
import { App } from "@zakki/web/client/App.tsx";
import { connectRouter } from "@zakki/web/client/router/controller.ts";
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
// パスキーでログインして自分の DB（RemoteIdentity）へ、無ければ従来どおり単一ユーザ構成で
// 起動する。ログインの get で PRF 出力も一緒に得ているので、そのまま封筒を開ける。
void Promise.all([
  import("@zakki/web/client/db/bootstrap.ts"),
  import("@zakki/web/client/api/control-plane.ts").then(async (m) => m.resolveRemoteSession()),
])
  .then(async ([m, remote]) => {
    const { db, passkey } = await m.bootstrapClientDb(
      remote === null
        ? {}
        : {
            fetchFn: remote.fetchFn,
            prf: remote.prf,
            dbName: `zakki-${remote.identity.userId}`,
          },
    );
    useGraphStore.getState().connect(db);
    useBufferStore.getState().connect(db);
    // パスキー登録 UI（#104）。DEK は bootstrap のクロージャに閉じたまま渡らない
    usePasskeyStore.getState().connect(passkey);
    connectRouter();
  })
  .catch((err: unknown) => {
    const message = errorMessage(err);
    console.error(`zakki-db: ${message}`);
    useGraphStore.getState().fail(`起動に失敗しました: ${message}`);
  });
