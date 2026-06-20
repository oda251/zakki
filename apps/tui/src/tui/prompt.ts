import { createInterface } from "node:readline";
import type { UnlockPrompts } from "@zakki/data/crypto/unlock.ts";

/**
 * opentui レンダラ起動前に使う stdin ベースの最小プロンプト群（Phase 6）。
 *
 * パスフレーズ／リカバリコードは画面エコーしない（生のキー入力を読み、改行で確定）。
 * 非 TTY では安全に失敗する（アプリは元々 TTY を要求する）。
 *
 * 入力した秘密はログに出さない（リカバリコードの 1 回表示のみ意図的な例外）。
 */

/** 1 行読む（改行まで、エコーあり）。Ctrl-C は中断扱いで reject。 */
export function readLine(promptText: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve, reject) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on("SIGINT", () => {
      rl.close();
      reject(new Error("入力が中断されました"));
    });
  });
}

const CR = 0x0d;
const LF = 0x0a;
const CTRL_C = 0x03;
const CTRL_D = 0x04;
const BACKSPACE = 0x08;
const DEL = 0x7f;

/**
 * パスフレーズを **エコーなし** で 1 行読む。
 *
 * stdin を raw モードにして 1 文字ずつ読み、画面には何も出さない（伝統的な
 * パスワード入力 UX）。Enter で確定、Backspace は 1 文字削除、Ctrl-C/Ctrl-D は中断。
 */
export function readPassphrase(promptText: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(new Error("パスフレーズ入力には対話端末（TTY）が必要です"));
  }
  process.stdout.write(promptText);

  return new Promise<string>((resolve, reject) => {
    let buf = "";
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = () => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === CR || code === LF) {
          cleanup();
          resolve(buf);
          return;
        }
        if (code === CTRL_C) {
          cleanup();
          reject(new Error("入力が中断されました"));
          return;
        }
        if (code === CTRL_D) {
          cleanup();
          if (buf.length === 0) {
            reject(new Error("入力が中断されました"));
          } else {
            resolve(buf);
          }
          return;
        }
        if (code === BACKSPACE || code === DEL) {
          buf = buf.slice(0, -1);
          continue;
        }
        // 制御文字は無視し、表示可能文字のみ取り込む
        if (code >= 0x20) {
          buf += ch;
        }
      }
    };

    stdin.on("data", onData);
  });
}

/**
 * 新パスフレーズを 2 回入力させ、一致するまで（最大 `maxTries` 回）繰り返す。
 * 一致したパスフレーズを返す。
 */
export async function readNewPassphraseTwice(maxTries = 3): Promise<string> {
  for (let i = 0; i < maxTries; i++) {
    const first = await readPassphrase("新しいパスフレーズ: ");
    if (first.length === 0) {
      process.stdout.write("空のパスフレーズは使えません。\n");
      continue;
    }
    const second = await readPassphrase("もう一度入力: ");
    if (first === second) {
      return first;
    }
    process.stdout.write("一致しません。もう一度。\n");
  }
  throw new Error("パスフレーズの確認に失敗しました");
}

/** リカバリコードを表示し、保存後に Enter で確認させる。 */
async function showRecoveryCode(code: string): Promise<void> {
  process.stdout.write("\n");
  process.stdout.write("==== リカバリコード（一度だけ表示）====\n");
  process.stdout.write("パスフレーズもキーファイルも失った場合の最後のアンロック手段です。\n");
  process.stdout.write("安全な場所に保管してください。\n\n");
  process.stdout.write(`    ${code}\n\n`);
  await readLine("保存したら Enter を押してください: ");
}

/** {@link UnlockPrompts} の stdin 実装。`unlockOrSetup` に注入する。 */
export const stdinPrompts: UnlockPrompts = {
  newPassphrase: () => readNewPassphraseTwice(),
  passphrase: () => readPassphrase("パスフレーズ: "),
  showRecoveryCode,
};
