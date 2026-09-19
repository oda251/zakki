import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { parseZakkiConfig } from "@zakki/core/config/env.ts";
// vite の設定ロード時は下記 resolve.alias が効かないため、相対パスで shared を参照する
import { API_BASE } from "./src/shared/api-base.ts";

// 開発は `bun run web`（API, :3777）と `bun run web:dev`（vite, :5173 proxy）の 2 プロセス。
// 本番は `vite build` の dist を API サーバが配信する（apps/web/src/server/index.ts）。
// vite の起動も合成点として扱い、環境変数をスキーマ検証してから使う（issue #48）。
const config = parseZakkiConfig(process.env).match(
  (c) => c,
  (message): never => {
    throw new Error(`zakki-web(vite): ${message}`);
  },
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@zakki/web": fileURLToPath(new URL("./src", import.meta.url)),
      "@zakki/core": fileURLToPath(new URL("../../packages/core/src", import.meta.url)),
      "@zakki/data": fileURLToPath(new URL("../../packages/data/src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      [API_BASE]: `http://localhost:${config.webPort}`,
    },
  },
});
