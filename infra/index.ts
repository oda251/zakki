import * as pulumi from "@pulumi/pulumi";
// Pulumi.yaml の packages 定義から `pulumi install` で生成されるローカル SDK
// （sdks/turso）。パッケージ名 "@pulumi/turso" は生成物で確認済み。
import * as turso from "@pulumi/turso";

// --- 設定 ----------------------------------------------------------------
// プロバイダ認証（turso:* 名前空間）:
//   turso:organization … Turso の組織名（stack config に平文で可）
//   turso:apiToken      … API トークン（必ず secret: pulumi config set --secret turso:apiToken <token>）
//                         未設定時は環境変数 TURSO_API_TOKEN が使われる
const tursoConfig = new pulumi.Config("turso");
const organization = tursoConfig.require("organization");

// アプリ固有設定（zakki-infra:* 名前空間）。stack ごとに上書きする。
const config = new pulumi.Config();
const stack = pulumi.getStack();
const groupName = config.get("groupName") ?? "zakki";
const dbName = config.get("dbName") ?? `zakki-${stack}`;
// 既定はリージョン東京（nrt）。Turso のロケーションキーで指定する。
const primaryLocation = config.get("primaryLocation") ?? "nrt";
const locations = config.getObject<string[]>("locations") ?? [primaryLocation];

// --- リソース ------------------------------------------------------------
// Turso group: DB を束ねるレプリカ群。DB 作成には事前に group が必要。
const group = new turso.Group("zakki", {
  name: groupName,
  primary: primaryLocation,
  locations,
  extensions: "all",
});

// 単一ユーザ用 Turso DB。Phase 4 の embedded replica がここへ sync する。
// （マルチユーザ化後の per-user DB は実行時 Platform API で作るため対象外）
const db = new turso.Database("zakki", {
  name: dbName,
  group: group.name,
});

// --- 出力 ----------------------------------------------------------------
// Phase 4（embedded replica）が参照する接続情報。
// 認証トークンは Pulumi では出力しない（最小権限の scoped トークンを別途発行する）:
//   turso db tokens create <dbName>
// 発行したトークンは XDG 設定 / 環境変数 / ESC 経由でアプリへ渡す（RESEARCH.md §6）。
export const databaseName = db.name;
export const tursoGroup = group.name;
export const tursoOrganization = organization;
// libSQL の同期先 URL。実ホスト名は Turso が払い出す（慣例: libsql://<db>-<org>.turso.io）。
export const databaseUrl = pulumi.interpolate`libsql://${db.name}-${organization}.turso.io`;
