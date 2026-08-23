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
      name: "api-control-plane-standalone",
      comment:
        "apps/api（コントロールプレーン, issue #99）はジャーナル系（packages/data・backend）・" +
        "他 app に依存しない。共有してよいのはランタイム非依存の packages/core のみ。" +
        "コントロールプレーン DB（apps/api/src/db）はジャーナル DB と完全に別物で、" +
        "node 依存（data の fs アダプタ等）の混入も同時に断つ",
      severity: "error",
      from: { path: "^apps/api/src" },
      to: { path: "^(packages/(data|backend)|apps/(tui|web))/" },
    },
    {
      name: "api-workers-portable",
      comment:
        "apps/api は Cloudflare Workers ランタイム（Web 標準 API のみ）。node 組み込みへ" +
        "到達しない（issue #99）。node:* / Bun 固有 API の全量は grep ガード" +
        "（scripts/check-arch-guards.sh Guard 5）が縛り、ここでは resolved 済みの fs / os を縛る。" +
        "テストは bun test で動くため除外",
      severity: "error",
      from: { path: "^apps/api/src", pathNot: "\\.test\\.ts$" },
      to: { dependencyTypes: ["core"], path: "^(fs|os)(/|$)" },
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
        "サーバに残すのは payload を不透明に扱う中継（replication）・封筒配布のみ。" +
        "暗号は opt-in で既定 OFF（issue #133）なので wire の doc は平文のこともあるが、" +
        "このルールは維持する: 担保しているのは「暗号文しか無い」ではなく" +
        "「サーバは中身を解釈せず復号能力も持たない」ことで、暗号の ON/OFF で変わらない",
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
      name: "web-server-no-sodium",
      comment:
        "web サーバは libsodium を直接 import しない（issue #134）。Workers では " +
        "`ready()` が**解決せずリクエストがハングする**（例外ではなく無応答なので気づきにくい。" +
        "bun では動くためテストでも再現しない — 実配備で初めて出た）。サーバが sodium に" +
        "求めていたのは base64 変換と長さ定数だけなので、sodium 非依存の " +
        "packages/core/src/crypto/wire.ts を使う。推移的な import（data の envelopes.ts 等）は" +
        "モジュール評価だけなら害が無いので、ここでは直接 import のみを禁じる",
      severity: "error",
      from: { path: "^apps/web/src/server", pathNot: "\\.test\\.(ts|tsx)$" },
      to: { path: "^packages/core/src/crypto/sodium\\.ts$" },
    },
    {
      name: "web-worker-portable",
      comment:
        "apps/web の Workers エントリ（worker.ts）から node 依存へ推移的に到達しない（issue #134）。" +
        "Workers にはファイルシステムが無く、ローカル DB も持たない。DB は " +
        "db/connect-web.ts（HTTP のみ）で開き、node:fs を引く db/connect.ts・" +
        "identity/local.ts・util/paths.ts・crypto/keyfile.ts へは（bootstrap.ts 経由でも）到達しない。" +
        "bun 用アダプタ（index.ts / bootstrap.ts）はこの制約の対象外",
      severity: "error",
      from: { path: "^apps/web/src/server/worker\\.ts$" },
      to: {
        path:
          "^packages/data/src/db/connect\\.ts$|" +
          "^packages/data/src/identity/local\\.ts$|" +
          "^packages/data/src/util/paths\\.ts$|" +
          "^packages/data/src/crypto/keyfile\\.ts$|" +
          "^(fs|os)(/|$)",
        reachable: true,
      },
    },
    {
      name: "web-no-server-conversion",
      comment:
        "web は（client/server とも）サーバ側かな漢字変換エンジン（backend/anco = AncoEngine）へ" +
        "推移的にも到達しない（issue #26）。変換はクライアント wasm 実行に移設済み。" +
        "AncoEngine 自体は TUI が使い続けるため撤去しない（web からの到達だけを断つ）",
      severity: "error",
      from: { path: "^apps/web/src", pathNot: "\\.test\\.(ts|tsx)$" },
      to: { path: "^packages/backend/src/anco/", reachable: true },
    },
    {
      name: "web-no-api-runtime",
      comment:
        "apps/web から apps/api（コントロールプレーン）への実 import 禁止（issue #105）。" +
        "両者は HTTP でしか繋がらない（別デプロイ・別ランタイム）。テスト・テスト用 fixture は" +
        "実物の Hono アプリをプロセス内で動かすため越境してよい（バンドルには載らない）",
      severity: "error",
      from: { path: "^apps/web/src", pathNot: "\\.test\\.(ts|tsx)$|/test-[^/]+\\.ts$" },
      to: { path: "^apps/api/src" },
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
