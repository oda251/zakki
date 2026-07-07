# zakki infra（Pulumi）

zakki のクラウドインフラを Pulumi（TypeScript）で宣言的に管理する。
**Phase 3 のスコープは Turso DB + group + secrets の最小スタック**。設計の正本: `../docs/RESEARCH.md §7`。

`infra/` は実行時コードではない（`apps/` / `packages/` の Bun workspaces とは分離。
ルートの `workspaces` 対象外なので bun は依存を管理しない）。

## 前提

- [Pulumi CLI](https://www.pulumi.com/docs/install/)
- Node.js（Pulumi nodejs ランタイム）
- Turso アカウントと API トークン（`turso auth api-tokens mint <name>` 等で発行）

## セットアップ

```bash
cd infra

# 1) 依存と Turso プロバイダ SDK を導入（clone 後の初回のみ）
#    Pulumi.yaml の packages 定義（celest-dev/turso, ブリッジ v1.1.4）から
#    ローカル SDK（sdks/turso, .gitignore 済み）を再生成し、npm 依存も入れる。
pulumi install

# 2) stack を作成
pulumi stack init dev      # 本番は prod

# 3) プロバイダ設定
pulumi config set turso:organization <your-turso-org>
pulumi config set --secret turso:apiToken <token>   # 平文でコミットしない
#   ※ apiToken は環境変数 TURSO_API_TOKEN でも可

# 4) プレビュー / 反映
pulumi preview
pulumi up
```

## 管理対象（Phase 3）

- `turso.Group`（`zakki`）— DB を束ねるレプリカ群。primary ロケーション既定 `nrt`（東京）。
- `turso.Database`（既定 `zakki-<stack>`）— 単一ユーザ用 DB。Phase 4 の embedded replica の同期先。

## 出力（Phase 4 が参照）

```bash
pulumi stack output databaseUrl        # libsql://<db>-<org>.turso.io
pulumi stack output databaseName
pulumi stack output tursoOrganization
```

**認証トークンは Pulumi の出力にしない**（最小権限の scoped トークンを別途発行する）:

```bash
turso db tokens create <databaseName>
```

発行した URL / トークンは XDG 設定・環境変数・Pulumi ESC のいずれかでアプリへ渡す
（E2E 原則: バックエンドは本文・暗号鍵を見ない。トークンは DB アクセス権のみ。`../docs/RESEARCH.md §6`）。

## 管理対象外（Pulumi では作らない）

- **ユーザごとの Turso DB** — マルチユーザ化後は実行時に Turso Platform API で生成する（Phase 7 バックエンド）。
- **Cloudflare Worker / DNS / コントロールプレーン DB** — Phase 7 で本ファイルに追加拡張する。

## 検証状況（2026-07-07 時点）

- **検証済み**: `pulumi install`（Pulumi CLI v3.231.0）で SDK 生成 →
  `tsc --noEmit` がエラーなしで通ること。生成パッケージ名は `@pulumi/turso`、
  `turso.Group`（name/primary/locations/extensions）・`turso.Database`（name/group）の
  プロパティ名も生成型と一致。SDK 生成に Turso の認証は不要（プロバイダスキーマのみ使用）。
- **未検証**: 実際の `pulumi up`（Turso アカウント + `TURSO_API_TOKEN` が必要）。
  プロバイダ本体（`celest-dev/terraform-provider-turso` v0.2.3）は 2025-02 に
  アーカイブ済みで、最新 Turso API とのランタイム互換は `pulumi up` 実行時に要確認。

出典:

- Turso Provider | Pulumi Registry — https://www.pulumi.com/registry/packages/turso/
- turso.Database — https://www.pulumi.com/registry/packages/turso/api-docs/database/
- turso.Group — https://www.pulumi.com/registry/packages/turso/api-docs/group/
- celest-dev/terraform-provider-turso — https://github.com/celest-dev/terraform-provider-turso
