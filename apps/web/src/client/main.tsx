import { createRoot } from "react-dom/client";
import { App } from "@zakki/web/client/App.tsx";
import { bootstrapClientDb } from "@zakki/web/client/db/bootstrap.ts";
import "@zakki/web/client/styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("#root が見つかりません");
}
createRoot(root).render(<App />);

// RxDB（Dexie storage）と replication の起動（issue #43）。UI の liveQuery 配線は #44 で
// 行うため fire-and-forget。アンロック不可・起動失敗でも既存 REST 経路の UI は動く。
void bootstrapClientDb().catch((err: unknown) => {
  console.error(`zakki-db: ${err instanceof Error ? err.message : String(err)}`);
});
