import { createRoot } from "react-dom/client";
import { errorMessage } from "@zakki/core/util/error.ts";
import { App } from "@zakki/web/client/App.tsx";
import { connectRouter } from "@zakki/web/client/router/controller.ts";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";
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
void import("@zakki/web/client/db/bootstrap.ts")
  .then(async (m) => {
    const { db } = await m.bootstrapClientDb();
    useGraphStore.getState().connect(db);
    useBufferStore.getState().connect(db);
    connectRouter();
  })
  .catch((err: unknown) => {
    const message = errorMessage(err);
    console.error(`zakki-db: ${message}`);
    useGraphStore.getState().fail(`起動に失敗しました: ${message}`);
  });
