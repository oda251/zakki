# zakki infra（Pulumi）

zakki のクラウドインフラを Pulumi（TypeScript）で宣言的に管理する。
スコープは **Turso（group + DB + コントロールプレーン DB）と Cloudflare Worker（`apps/api`）**。
設計の正本: `../docs/RESEARCH.md §7`。

`infra/` は実行時コードではない（`apps/` / `packages/` の Bun workspaces とは分離。
ルートの `workspaces` 対象外なので bun は依存を管理しない）。

## 前提

- [Pulumi CLI](https://www.pulumi.com/docs/install/)
- Node.js（Pulumi nodejs ランタイム）
- Turso アカウントと API トークン（`turso auth api-tokens mint <name>` 等で発行）
- （Worker を配備する場合）Cloudflare アカウントと API トークン
  （権限: `Workers Scripts:Edit`。route/custom domain を使うなら該当 zone の編集権限も）

## セットアップ

```bash
cd infra

# 1) 依存と Turso プロバイダ SDK を導入（clone 後の初回のみ）
#    Pulumi.yaml の packages 定義（celest-dev/turso, ブリッジ v1.1.4）から
#    ローカル SDK（sdks/turso, .gitignore 済み）を再生成し、npm 依存も入れる。
#    @pulumi/cloudflare は通常の npm 依存としてここで入る。
pulumi install

# 2) stack を作成
pulumi stack init dev      # 本番は prod

# 3) プロバイダ設定
pulumi config set turso:organization <your-turso-org>
# secret は値をコマンド引数に置かず stdin から渡す（下の set_secret を定義しておく）
set_secret() { printf %s "$2" | pulumi config set --secret "$1"; }
set_secret turso:apiToken "$TURSO_API_TOKEN"
#   ※ apiToken は config を設定せず環境変数 TURSO_API_TOKEN のままでも可

# 4) プレビュー / 反映（反映はユーザが実行する）
pulumi preview
pulumi up
```

## 必要な config 一覧

| キー | 必須 | 説明 |
| --- | --- | --- |
| `turso:organization` | ✔ | Turso 組織名（平文で可） |
| `turso:apiToken` | ✔（secret） | Turso API トークン。環境変数 `TURSO_API_TOKEN` でも可 |
| `groupName` | | Turso group 名（既定 `zakki`） |
| `dbName` | | 単一ユーザ DB 名（既定 `zakki-<stack>`） |
| `controlDbName` | | コントロールプレーン DB 名（既定 `zakki-control-<stack>`） |
| `primaryLocation` / `locations` | | Turso ロケーション（既定 `nrt`） |
| `deployWorker` | | `true` で Cloudflare Worker を配備（**既定 `false`**。下記参照） |

`deployWorker=true` のとき追加で必要:

| キー | 必須 | 説明 |
| --- | --- | --- |
| `cloudflare:apiToken` | ✔（secret） | Cloudflare API トークン。環境変数 `CLOUDFLARE_API_TOKEN` でも可 |
| `cloudflareAccountId` | ✔ | Cloudflare アカウント ID |
| `sessionSecret` | ✔（secret） | Worker の `SESSION_SECRET` |
| `workerTursoApiToken` | ✔（secret） | Worker の `TURSO_API_TOKEN`（per-user DB 生成用。最小権限で別途発行） |
| `controlDbToken` | ✔（secret） | Worker の `CONTROL_DB_TOKEN`（発行手順は末尾「トークンの発行」を参照） |
| `workerName` | | Worker スクリプト名（既定 `zakki-api-<stack>`） |
| `workerBundlePath` | | ビルド成果物のパス（既定 `../apps/api/dist/index.js`、infra/ 基準） |
| `workerCompatibilityDate` | | Workers ランタイム互換日付（既定 `2026-07-01`） |
| `workersDevEnabled` | | workers.dev サブドメイン公開（既定 `true`） |
| `rpId` / `rpOrigin` | ✔ | WebAuthn RP 設定（apps/api の env スキーマで必須。例 `rpId=example.com`, `rpOrigin=https://example.com`） |
| `cloudflareZoneId` | route/domain 使用時 | 対象 zone の ID |
| `workerRoutePattern` | | 設定時のみ `WorkersRoute` を作成（例 `api.example.com/*`） |
| `workerCustomDomain` | | 設定時のみ `WorkersCustomDomain` を作成（例 `api.example.com`） |

secret は必ず CLI で設定する（コミットしない）。実値はコマンド引数に置かず
stdin から渡す（シェル履歴・プロセス一覧に残さない）。上で定義した `set_secret` を使う:

```bash
set_secret() { printf %s "$2" | pulumi config set --secret "$1"; }

set_secret sessionSecret        "$SESSION_SECRET"
set_secret workerTursoApiToken  "$WORKER_TURSO_API_TOKEN"
set_secret controlDbToken       "$CONTROL_DB_TOKEN"
set_secret cloudflare:apiToken  "$CLOUDFLARE_API_TOKEN"
```

## 管理対象

- `turso.Group`（`zakki`）— DB を束ねるレプリカ群。primary ロケーション既定 `nrt`（東京）。
- `turso.Database`（既定 `zakki-<stack>`）— 単一ユーザ用 DB。Phase 4 の embedded replica の同期先。
- `turso.Database`（既定 `zakki-control-<stack>`）— **コントロールプレーン DB**（Phase 7）。
  `apps/api` が accounts / credentials / account_databases 台帳を置く。
  本文・鍵・DEK は置かない（E2E 原則、`../docs/RESEARCH.md §6-7`）。
- `cloudflare.WorkersScript`（`deployWorker=true` のときのみ）— `apps/api` のバンドルを配備。
  secrets（`SESSION_SECRET` / `TURSO_API_TOKEN` / `CONTROL_DB_TOKEN`）は `secret_text`
  binding、非秘匿設定（`CONTROL_DB_URL` / `TURSO_ORG` / `TURSO_GROUP` 等）は
  `plain_text` binding として定義する。
- `cloudflare.WorkersScriptSubdomain` — workers.dev 公開の on/off。
- `cloudflare.WorkersRoute` / `cloudflare.WorkersCustomDomain` — config 設定時のみ。

### deployWorker フラグ

`apps/api`（issue #99）のビルド成果物が無い環境でも既存スタックの
`pulumi preview` / `up` が壊れないよう、Worker 関連リソースは既定で作らない。
成果物（既定 `apps/api/dist/index.js`、単一 ES Module）を用意してから有効化する:

```bash
pulumi config set deployWorker true
```

## Worker のデプロイ手順（ユーザが実行）

1. `apps/api` をバンドルする（単一ファイル、ES Module）:

   ```bash
   bun build apps/api/src/index.ts --target=browser --outfile apps/api/dist/index.js
   # apps/api 側に build スクリプトがあればそちらを使う
   ```

2. `deployWorker` と必要な config / secrets（上表）を設定して反映:

   ```bash
   cd infra && pulumi preview && pulumi up
   ```

3. コード変更の再デプロイも同じ流れ（再バンドル → `pulumi up`。
   `contentSha256` の変化で更新が検知される）。

**Wrangler との使い分け**（Cloudflare 推奨の併用方針、`../docs/RESEARCH.md §7`）:
リソース（スクリプト・binding・route・DNS）は Pulumi で管理し、
ローカル開発（`wrangler dev`）や tail などの運用コマンドに Wrangler を使う。
`wrangler deploy` を併用すると Pulumi 管理の binding 構成とドリフトするため、
デプロイは `pulumi up` に一本化する。

## 出力

```bash
pulumi stack output databaseUrl           # libsql://<db>-<org>.turso.io（Phase 4 が参照）
pulumi stack output databaseName
pulumi stack output controlDatabaseUrl    # apps/api の CONTROL_DB_URL
pulumi stack output controlDatabaseName
pulumi stack output tursoOrganization
pulumi stack output workerScriptName      # deployWorker=false のときは空
```

**認証トークンは Pulumi の出力にしない**（最小権限の scoped トークンを別途発行する）:

```bash
turso db tokens create <databaseName>
```

発行した URL / トークンは XDG 設定・環境変数・Pulumi ESC のいずれかでアプリへ渡す
（E2E 原則: バックエンドは本文・暗号鍵を見ない。トークンは DB アクセス権のみ。`../docs/RESEARCH.md §6`）。

## 管理対象外（Pulumi では作らない）

- **ユーザごとの Turso DB** — マルチユーザ化後は実行時に `apps/api` が Turso Platform API で
  生成する（Phase 7 バックエンド）。数が可変なので IaC state には載せない。

## 検証状況（2026-07-26 時点）

- **検証済み**: `pulumi install`（SDK 生成）→ `tsc --noEmit` がエラーなしで通ること。
  ローカル file backend + ダミー config での `pulumi preview` が
  `deployWorker=false`（Turso 3 リソースのみ・既存 URN 不変）/ `true`
  （+ `WorkersScript` / `WorkersScriptSubdomain`）の両方で成功すること。
  preview では provider への実 API 呼び出しは発生しないため credential 不要。
- **未検証**: 実際の `pulumi up`（Turso / Cloudflare の実トークンが必要。ユーザが実行する）。
  プロバイダ本体（`celest-dev/terraform-provider-turso` v0.2.3）は 2025-02 に
  アーカイブ済みで、最新 Turso API とのランタイム互換は `pulumi up` 実行時に要確認。

出典:

- Turso Provider | Pulumi Registry — https://www.pulumi.com/registry/packages/turso/
- turso.Database — https://www.pulumi.com/registry/packages/turso/api-docs/database/
- turso.Group — https://www.pulumi.com/registry/packages/turso/api-docs/group/
- celest-dev/terraform-provider-turso — https://github.com/celest-dev/terraform-provider-turso
- cloudflare.WorkersScript — https://www.pulumi.com/registry/packages/cloudflare/api-docs/workersscript/
- Cloudflare + Pulumi ガイド — https://developers.cloudflare.com/pulumi/
