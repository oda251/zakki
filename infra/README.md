# zakki infra（Pulumi / Cloudflare）

zakki の **Cloudflare リソース**を Pulumi（TypeScript）で宣言的に管理する。
スコープは `apps/api`（コントロールプレーン Worker）とその公開設定だけ。
設計の正本: `../docs/RESEARCH.md §7`。

`infra/` は実行時コードではない（`apps/` / `packages/` の Bun workspaces とは分離。
ルートの `workspaces` 対象外なので bun は依存を管理しない）。

## Turso はここで管理しない（issue #129 / #132）

group もコントロールプレーン DB も **アプリ側**が作る。`just provision` /
`just migrate-control` の 2 コマンドで立ち上がる（手順は `../docs/MULTIUSER.md`）。

理由:

- Turso は IaC を提供も推奨もしていない。ドキュメント全ページ索引（<https://docs.turso.tech/llms.txt>）に
  `terraform` / `pulumi` / `infrastructure` の語が 1 件も無く、公式の管理手段は CLI と Platform API（+ 公式 TS SDK）だけ
- Registry にある turso プロバイダ 3 つはすべて非公式。実際に使った `celest-dev/turso`
  （2025-02 アーカイブ済み）は **DB 作成が現行 API では必ず失敗した**（作成直後の設定更新に
  `size_limit` を載せ、API が `size_limit is not supported for db-api controlled databases` で 400 を返す。
  DB は作られるのに Pulumi は失敗し state に載らない。2026-08-19 実測）
- ユーザごとの DB を実行時に作る経路（`apps/api/src/turso/provision.ts`）は元々あり、
  IaC に取り残されていたのは静的な 3 リソースだけだった

## 前提

- [Pulumi CLI](https://www.pulumi.com/docs/install/)
- Node.js（Pulumi nodejs ランタイム）
- Cloudflare アカウントと API トークン
  （権限: `Workers Scripts:Edit`。route/custom domain を使うなら該当 zone の編集権限も）
- `just provision` 済みのコントロールプレーン DB（`CONTROL_DB_URL` / `CONTROL_DB_TOKEN`）

## セットアップ

```bash
cd infra

# 1) 依存を導入（clone 後の初回のみ）
pulumi install

# 2) stack を作成
pulumi stack init dev      # 本番は prod

# 3) 設定
pulumi config set tursoOrganization <your-turso-org>
pulumi config set controlDbUrl      <just provision が出した CONTROL_DB_URL>

# secret は値をコマンド引数に置かず stdin から渡す
set_secret() { printf %s "$2" | pulumi config set --secret "$1"; }
set_secret cloudflare:apiToken "$CLOUDFLARE_API_TOKEN"
#   ※ apiToken は config を設定せず環境変数 CLOUDFLARE_API_TOKEN のままでも可

# 4) プレビュー / 反映（反映はユーザが実行する）
pulumi preview
pulumi up
```

## 必要な config 一覧

Worker を作らない（`deployWorker=false`、既定）なら **このスタックは何も作らない**。

| キー | 必須 | 説明 |
| --- | --- | --- |
| `deployWorker` | | `true` で Cloudflare Worker を配備（**既定 `false`**。下記参照） |

`deployWorker=true` のとき必要:

| キー | 必須 | 説明 |
| --- | --- | --- |
| `cloudflare:apiToken` | ✔（secret） | Cloudflare API トークン。環境変数 `CLOUDFLARE_API_TOKEN` でも可 |
| `cloudflareAccountId` | ✔ | Cloudflare アカウント ID |
| `controlDbUrl` | ✔ | Worker の `CONTROL_DB_URL`（`just provision` の出力） |
| `tursoOrganization` | ✔ | Worker の `TURSO_ORG` |
| `tursoGroup` | | Worker の `TURSO_GROUP`（既定 `zakki`。`just provision` の `TURSO_GROUP` と揃える） |
| `sessionSecret` | ✔（secret） | Worker の `SESSION_SECRET` |
| `workerTursoApiToken` | ✔（secret） | Worker の `TURSO_API_TOKEN`（per-user DB 生成用。最小権限で別途発行） |
| `controlDbToken` | ✔（secret） | Worker の `CONTROL_DB_TOKEN`（`just provision` の出力） |
| `rpId` / `rpOrigin` | ✔ | WebAuthn RP 設定（例 `rpId=example.com`, `rpOrigin=https://example.com`） |
| `workerName` | | Worker スクリプト名（既定 `zakki-api-<stack>`） |
| `workerBundlePath` | | ビルド成果物のパス（既定 `../apps/api/dist/index.js`、infra/ 基準） |
| `workerCompatibilityDate` | | Workers ランタイム互換日付（既定 `2026-07-01`） |
| `workersDevEnabled` | | workers.dev サブドメイン公開（既定 `true`） |
| `cloudflareZoneId` | route/domain 使用時 | 対象 zone の ID |
| `workerRoutePattern` | | 設定時のみ `WorkersRoute` を作成（例 `api.example.com/*`） |
| `workerCustomDomain` | | 設定時のみ `WorkersCustomDomain` を作成（例 `api.example.com`） |

secret は必ず CLI で設定する（コミットしない）。実値はコマンド引数に置かず
stdin から渡す（シェル履歴・プロセス一覧に残さない）:

```bash
set_secret() { printf %s "$2" | pulumi config set --secret "$1"; }

set_secret sessionSecret        "$SESSION_SECRET"
set_secret workerTursoApiToken  "$WORKER_TURSO_API_TOKEN"
set_secret controlDbToken       "$CONTROL_DB_TOKEN"
set_secret cloudflare:apiToken  "$CLOUDFLARE_API_TOKEN"
```

## 管理対象

- `cloudflare.WorkersScript`（`deployWorker=true` のときのみ）— `apps/api` のバンドルを配備。
  secrets（`SESSION_SECRET` / `TURSO_API_TOKEN` / `CONTROL_DB_TOKEN`）は `secret_text`
  binding、非秘匿設定（`CONTROL_DB_URL` / `TURSO_ORG` / `TURSO_GROUP` / `RP_ID` / `RP_ORIGIN`）は
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
   bun run --cwd apps/api build   # apps/api/dist/index.js に出力される
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
pulumi stack output workerScriptName      # deployWorker=false のときは空
```

Turso の接続情報はここから出さない（Pulumi が作らないため）。所在とトークンは
`just provision` の出力が一次情報で、この stack へは config として入る。

## 既存 stack の移行（issue #132、ユーザが実行）

すでに Turso リソースを載せた stack（`prod`）がある場合、**実リソースを消さずに**
state からだけ外す:

```bash
cd infra
# 正確な URN は `pulumi stack --show-urns` で確認する。
# **DB を先に、group を後に**（DB は group に依存しており、依存される側は先に外せない）
pulumi state remove 'urn:pulumi:prod::zakki-infra::turso:index/database:Database::zakki'
pulumi state remove 'urn:pulumi:prod::zakki-infra::turso:index/database:Database::zakki-control'
pulumi state remove 'urn:pulumi:prod::zakki-infra::turso:index/group:Group::zakki'

pulumi preview   # Cloudflare リソースのみ・差分なしになることを確認
```

`pulumi state remove` は **state から外すだけ**でクラウド上のリソースには触れない
（"Deletes one or more resources from a stack's state"。`pulumi state remove --help`,
Pulumi CLI v3.258.0）。`pulumi destroy` と取り違えないこと。`delete` / `rm` は同じ
コマンドの別名。

古い config も不要になる:

```bash
pulumi config rm turso:organization
pulumi config rm turso:apiToken      # `just provision` で使い回すなら残してよい
pulumi config rm dbName
pulumi config rm primaryLocation
```

## 管理対象外

- **Turso の group・コントロールプレーン DB** — `just provision` が作る（上記）。
- **ユーザごとの Turso DB** — 実行時に `apps/api` が Turso Platform API で生成する。
  数が可変なので IaC state には載せない。

## 検証状況（2026-08-21 時点）

- **検証済み**: Turso を外す前の stack `prod` での `pulumi up`（Turso group の作成、
  Database は import 経由で `pulumi preview` 差分なし）。
- **未検証**: `deployWorker=true` の Cloudflare 側（Worker のバンドル配備・binding・route）。
  Turso を外したあとの `pulumi preview`（issue #132 の受け入れ確認。ユーザが実行）。

出典:

- cloudflare.WorkersScript — https://www.pulumi.com/registry/packages/cloudflare/api-docs/workersscript/
- Cloudflare + Pulumi ガイド — https://developers.cloudflare.com/pulumi/
- pulumi state delete — https://www.pulumi.com/docs/iac/cli/commands/pulumi_state_delete/
- Turso ドキュメント索引（IaC の記載が無いことの根拠） — https://docs.turso.tech/llms.txt
