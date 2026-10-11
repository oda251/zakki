import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
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
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      injectRegister: false,
      registerType: "autoUpdate",
      includeAssets: [
        "favicon.ico",
        "favicon.svg",
        "favicon-32x32.png",
        "apple-touch-icon-180x180.png",
      ],
      manifest: {
        name: "zakki",
        short_name: "zakki",
        description: "考えを入力する以外の操作を可能な限り省く、思考記録ツール",
        lang: "ja",
        theme_color: "#1a1a19",
        background_color: "#0d0d0d",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        scope: "/",
        id: "/",
        icons: [
          {
            src: "/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-maskable-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "/pwa-maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            urlPattern: /^\/api\/.*/,
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
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
