import { createRoot } from "react-dom/client";
import { App } from "@zakki/web/client/App.tsx";
import "@zakki/web/client/styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("#root が見つかりません");
}
createRoot(root).render(<App />);
