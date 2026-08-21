import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

// --- 設定 ----------------------------------------------------------------
// このスタックのスコープは **Cloudflare だけ**（issue #132）。Turso の group・DB は
// アプリ側（`just provision`）が作る: Turso は IaC を提供も推奨もしておらず、
// 非公式プロバイダは現行 API と非互換だった（issue #129, docs/MULTIUSER.md）。
//
// プロバイダ認証（cloudflare:* 名前空間、deployWorker=true のときのみ必要）:
//   cloudflare:apiToken … Cloudflare API トークン（必ず secret）。
//                         未設定時は環境変数 CLOUDFLARE_API_TOKEN が使われる
//
// アプリ固有設定（zakki-infra:* 名前空間）。stack ごとに上書きする。
const config = new pulumi.Config();
const stack = pulumi.getStack();

// --- Cloudflare Worker（apps/api）----------------------------------------
// apps/api（#99）のビルド成果物が無くても既存スタックの preview が壊れない
// よう、既定 false のフラグでリソース生成ごとスキップできるようにする。
//   pulumi config set deployWorker true
const deployWorker = config.getBoolean("deployWorker") ?? false;

let workerScriptNameOutput: pulumi.Output<string> | undefined;

if (deployWorker) {
  // Cloudflare アカウント ID（dash の Workers & Pages 画面で確認できる）。
  const accountId = config.require("cloudflareAccountId");
  const workerName = config.get("workerName") ?? `zakki-api-${stack}`;

  // apps/api のバンドル（単一 ES Module）。パスの取り決め: apps/api 側の
  // `bun build --target=browser` 等が dist/index.js に出力する（issue #102 / #99）。
  // infra/ からの相対パスまたは絶対パスを config で上書きできる。
  const bundlePath = path.resolve(
    __dirname,
    config.get("workerBundlePath") ?? "../apps/api/dist/index.js",
  );
  if (!fs.existsSync(bundlePath)) {
    throw new Error(
      `Worker バンドルが見つかりません: ${bundlePath}\n` +
        "先に apps/api をビルドするか、deployWorker を false に戻してください。",
    );
  }
  // contentFile 使用時は contentSha256 が必須（内容変更の検知に使われる）。
  const contentSha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(bundlePath))
    .digest("hex");

  // Worker が参照する secrets（sessionSecret / workerTursoApiToken / controlDbToken）。
  // 値は必ず secret 指定で設定しコミットしない。設定手順は infra/README.md を参照
  // （実値は stdin から渡し、シェル履歴・プロセス一覧に残さない）。
  //   workerTursoApiToken … per-user DB 生成用。最小権限で別途発行する
  //   controlDbToken      … `just provision` が出力する CONTROL_DB_TOKEN
  const bindings: pulumi.Input<cloudflare.types.input.WorkersScriptBinding>[] = [
    {
      name: "SESSION_SECRET",
      type: "secret_text",
      text: config.requireSecret("sessionSecret"),
    },
    {
      name: "TURSO_API_TOKEN",
      type: "secret_text",
      text: config.requireSecret("workerTursoApiToken"),
    },
    {
      name: "CONTROL_DB_TOKEN",
      type: "secret_text",
      text: config.requireSecret("controlDbToken"),
    },
    // 非秘匿の実行時設定（apps/api の env スキーマと対応、issue #99）。
    // controlDbUrl は Pulumi が DB を作らなくなったので config から供給する
    // （`just provision` が出力する CONTROL_DB_URL をそのまま入れる）。
    { name: "CONTROL_DB_URL", type: "plain_text", text: config.require("controlDbUrl") },
    { name: "TURSO_ORG", type: "plain_text", text: config.require("tursoOrganization") },
    { name: "TURSO_GROUP", type: "plain_text", text: config.get("tursoGroup") ?? "zakki" },
  ];
  // WebAuthn の RP 設定。apps/api の env スキーマ（PR #108）では必須のため、
  // 未設定のまま配備すると Worker が全リクエストで env 検証に失敗する。
  // deployWorker=true のときは require で早期に落とす。
  bindings.push({ name: "RP_ID", type: "plain_text", text: config.require("rpId") });
  bindings.push({ name: "RP_ORIGIN", type: "plain_text", text: config.require("rpOrigin") });

  // 現行 @pulumi/cloudflare v6 の GA リソースは WorkersScript
  // （v5 の WorkerScript は廃止。beta の Worker/WorkerVersion/WorkersDeployment
  // 3 分割はまだ採らない — 単一リソースで十分なため）。
  const worker = new cloudflare.WorkersScript("zakki-api", {
    accountId,
    scriptName: workerName,
    contentFile: bundlePath,
    contentSha256,
    // バンドルのファイル名がそのままエントリモジュール名になる
    // （workerBundlePath 上書き時も食い違わないよう basename から導出）。
    mainModule: path.basename(bundlePath),
    compatibilityDate: config.get("workerCompatibilityDate") ?? "2026-07-01",
    bindings,
    observability: { enabled: true },
  });
  workerScriptNameOutput = worker.scriptName;

  // workers.dev サブドメインでの公開（既定 true）。route / custom domain を
  // 使う場合は workersDevEnabled=false にして無効化できる。
  new cloudflare.WorkersScriptSubdomain("zakki-api", {
    accountId,
    scriptName: worker.scriptName,
    enabled: config.getBoolean("workersDevEnabled") ?? true,
  });

  // route / custom domain は任意（未設定なら作らない = workers.dev 前提）。
  const zoneId = config.get("cloudflareZoneId");
  const routePattern = config.get("workerRoutePattern");
  if (routePattern) {
    if (!zoneId) {
      throw new Error("workerRoutePattern には cloudflareZoneId の設定が必要です");
    }
    new cloudflare.WorkersRoute("zakki-api", {
      zoneId,
      pattern: routePattern,
      script: worker.scriptName,
    });
  }
  const customDomain = config.get("workerCustomDomain");
  if (customDomain) {
    if (!zoneId) {
      throw new Error("workerCustomDomain には cloudflareZoneId の設定が必要です");
    }
    new cloudflare.WorkersCustomDomain("zakki-api", {
      accountId,
      zoneId,
      hostname: customDomain,
      service: worker.scriptName,
    });
  }
}

// --- 出力 ----------------------------------------------------------------
// Turso の接続情報はここから出さない（Pulumi が作らないため）。所在とトークンは
// `just provision` の出力が一次情報で、この stack へは config として入る。
// Worker のスクリプト名（deployWorker=false のときは空文字列 = 未作成）。
export const workerScriptName = workerScriptNameOutput ?? pulumi.output("");
