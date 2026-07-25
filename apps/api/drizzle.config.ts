import { defineConfig } from "drizzle-kit";

/**
 * コントロールプレーン DB（issue #99）の migration 生成設定。
 * 生成物は apps/api/drizzle/。適用はデプロイ時に primary（Turso）へ行い、
 * Workers ランタイムでは migrate しない（drizzle migrator は node:fs 依存の
 * ため。packages/data/src/db/connect.ts の migrateDb と同じ理由）。
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
