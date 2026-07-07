/**
 * アーキテクチャ依存ルール（2026-07 監査で確認した健全な依存方向の恒久化）。
 * レイヤー: core ← data ← backend ← apps。type-only 依存は境界を越えてよい
 * （apps/web/src/shared/api-types.ts の型 re-export 等）。
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "ランタイム循環の禁止（import type のみのエッジは循環に数えない）",
      severity: "error",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
    {
      name: "core-stays-leaf",
      comment: "@zakki/core は他パッケージ・アプリに依存しない",
      severity: "error",
      from: { path: "^packages/core/src" },
      to: { path: "^(packages/(data|backend)|apps)/" },
    },
    {
      name: "data-node-fs-only-in-adapters",
      comment:
        "packages/data のリポジトリ・クエリ群から node:fs / node:os へ到達しない（issue #29）。" +
        "fs 依存は DB アダプタ（db/connect.ts）・keyfile・identity・paths（合成点専用）に封じ込める",
      severity: "error",
      from: {
        path: "^packages/data/src",
        pathNot:
          "^packages/data/src/(db/connect\\.ts|crypto/keyfile\\.ts|identity/local\\.ts|util/paths\\.ts)$|\\.test\\.ts$",
      },
      // node: 組み込みの resolved 名はプレフィクスなし（node:fs → fs）
      to: { dependencyTypes: ["core"], path: "^(fs|os)(/|$)" },
    },
    {
      name: "data-no-upward",
      comment: "@zakki/data から backend / apps への逆流禁止",
      severity: "error",
      from: { path: "^packages/data/src" },
      to: { path: "^(packages/backend|apps)/" },
    },
    {
      name: "backend-no-apps",
      comment: "@zakki/backend から apps への逆流禁止",
      severity: "error",
      from: { path: "^packages/backend/src" },
      to: { path: "^apps/" },
    },
    {
      name: "backend-no-schema-internals",
      comment:
        "@zakki/backend から data の schema.ts への直接 import 禁止（issue #53 / #59）。" +
        "どのテーブルにどう書くか（永続化）は data の適用関数・クエリ" +
        "（analysis/apply.ts・analysis/queries.ts 等）に封じ込める。" +
        "テストは DB 実体の検証で参照してよい",
      severity: "error",
      from: { path: "^packages/backend/src", pathNot: "\\.test\\.(ts|tsx)$" },
      to: { path: "^packages/data/src/db/schema\\.ts$" },
    },
    {
      name: "web-client-server-boundary",
      comment:
        "web の client ↔ server 相互 import 禁止（shared のみ共有点）。テストは純ロジックの検証で越境してよい",
      severity: "error",
      from: { path: "^apps/web/src/client", pathNot: "\\.test\\.(ts|tsx)$" },
      to: { path: "^apps/web/src/server", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "web-server-no-client",
      severity: "error",
      from: { path: "^apps/web/src/server", pathNot: "\\.test\\.(ts|tsx)$" },
      to: { path: "^apps/web/src/client", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "web-server-no-decrypt-capability",
      comment:
        "web サーバは DEK・復号能力へ（推移的にも）到達しない（issue #45 / #28 項目1）。" +
        "復号（crypto-context / getCrypto）・アンロック（unlock / keyfile / init）・" +
        "平文前提の解析（backend/analysis・embedding）はクライアント wasm / TUI の責務。" +
        "サーバに残すのは暗号文の中継（replication）・封筒配布・変換エンジンのみ",
      severity: "error",
      from: { path: "^apps/web/src/server", pathNot: "\\.test\\.(ts|tsx)$" },
      to: {
        path:
          "^packages/data/src/db/crypto-context\\.ts$|" +
          "^packages/data/src/crypto/(unlock|keyfile|init|guard)\\.ts$|" +
          "^packages/backend/src/(analysis|embedding)/|" +
          "^packages/core/src/crypto/fields\\.ts$",
        reachable: true,
      },
    },
    {
      name: "web-client-no-data-runtime",
      comment:
        "client から @zakki/data の実 import 禁止（node 依存の混入防止。型は shared 経由で可）。" +
        "テストは実サーバ（libSQL）との統合検証で越境してよい（バンドルに載らない）",
      severity: "error",
      from: { path: "^apps/web/src/(client|shared)", pathNot: "\\.test\\.(ts|tsx)$" },
      to: { path: "^packages/data/src", dependencyTypesNot: ["type-only"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // ビルド成果物は検査対象外（CI は build 前に cruise するが、ローカルで dist が
    // 残っていると minify 済み JS を誤検査する。oxlint の ignorePatterns と同じ方針）
    exclude: { path: "^apps/web/dist" },
    tsConfig: { fileName: "tsconfig.base.json" },
    tsPreCompilationDeps: true,
    // fs / os（node: 組み込みの resolved 名）は data-node-fs-only-in-adapters の
    // 検査対象としてグラフに含める
    includeOnly: "^(apps|packages)/|^(fs|os)(/|$)",
  },
};
