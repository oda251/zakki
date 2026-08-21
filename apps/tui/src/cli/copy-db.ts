/**
 * ジャーナル DB の移送 CLI（issue #136）。
 *   bun run copy-db          … source → target へ全行を写し、照合結果を出す
 *   bun run copy-db --verify … 写さず照合だけ行う（移行後の再確認）
 *
 * 単一ユーザ DB（`zakki-prod`）を per-user DB へ畳むための **一度きりの移行**。
 * 接続情報は環境変数で渡す:
 *   ZAKKI_SOURCE_URL / ZAKKI_SOURCE_TOKEN … 移行元（省略時はローカルの既定 DB）
 *   ZAKKI_TARGET_URL / ZAKKI_TARGET_TOKEN … 移行先（`just db-token` の出力）
 *
 * **target が空でなければ何もせず終了する**。既存行があるところへ流すと id 衝突か
 * 重複になり、どちらも黙って壊れるため（マージの意味論は決まらない）。
 *
 * 移行前に source のスナップショットを取ること（手順は docs/MULTIUSER.md）。
 * 暗号は関知しない: 行をそのまま運ぶので、暗号 ON の DB は暗号文のまま移る。
 * 平文化したいなら先に `just decrypt` を通す（issue #133）。
 */
import { copyJournal, findExistingRows, verifyCopy } from "@zakki/data/db/copy.ts";
import { createDb, defaultDbPath, openRemoteDb } from "@zakki/data/db/connect.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { xdgDataHome } from "@zakki/data/util/paths.ts";
import { loadConfigOrExit } from "@zakki/tui/config.ts";

// 合成点: 環境変数を起動時に一度だけ検証する（issue #48）
const config = loadConfigOrExit(process.env);
const env = process.env;
const verifyOnly = process.argv.includes("--verify");

/** 移行元。URL 未指定ならローカルの既定 DB（埋め込みレプリカを作らず素で開く） */
async function openSource(): Promise<Db> {
  const url = env.ZAKKI_SOURCE_URL;
  const token = env.ZAKKI_SOURCE_TOKEN;
  if (url === undefined || url === "") {
    return await createDb(defaultDbPath(xdgDataHome(config.xdgDataHome)));
  }
  return await openRemoteDb({ userId: "source", tursoUrl: url, tursoToken: token });
}

const targetUrl = env.ZAKKI_TARGET_URL;
const targetToken = env.ZAKKI_TARGET_TOKEN;
if (targetUrl === undefined || targetUrl === "" || targetToken === undefined) {
  console.error(
    "zakki copy-db: ZAKKI_TARGET_URL と ZAKKI_TARGET_TOKEN を設定してください（`just db-token` の出力）",
  );
  process.exit(1);
}

const source = await openSource();
// openRemoteDb は migration を適用する（空の per-user DB にスキーマが入る）
const target = await openRemoteDb({
  userId: "target",
  tursoUrl: targetUrl,
  tursoToken: targetToken,
});

if (!verifyOnly) {
  const existing = await findExistingRows(target);
  if (existing.length > 0) {
    console.error("zakki copy-db: 移行先が空ではありません。中止します:");
    for (const { name, rows } of existing) {
      console.error(`  ${name}: ${rows} 行`);
    }
    process.exit(1);
  }
  const copied = await copyJournal(target, source);
  for (const { name, rows } of copied) {
    console.error(`zakki copy-db: ${name} … ${rows} 行`);
  }
}

// 行数と内容ハッシュで照合する（移行の受け入れ条件）
const comparisons = await verifyCopy(target, source);
for (const c of comparisons) {
  const mark = c.matches ? "OK " : "NG ";
  console.log(
    `${mark}${c.name}: ${c.sourceRows} → ${c.targetRows} 行 / ${c.sourceHash.slice(0, 12)} → ${c.targetHash.slice(0, 12)}`,
  );
}
const mismatched = comparisons.filter((c) => !c.matches);
if (mismatched.length > 0) {
  console.error(`zakki copy-db: 一致しない表が ${mismatched.length} 件あります`);
  process.exit(1);
}
console.error("zakki copy-db: すべての表が一致しました");
