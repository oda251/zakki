import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// 開発は `bun run web`（API, :3777）と `bun run web:dev`（vite, :5173 proxy）の 2 プロセス。
// 本番は `vite build` の dist を API サーバが配信する（apps/web/src/server/index.ts）。
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
      "/api": `http://localhost:${process.env["ZAKKI_WEB_PORT"] ?? 3777}`,
    },
  },
});
