import { describe, expect, test } from "bun:test";
import { AncoEngine } from "./engine.ts";
import type { AncoProcess, SpawnAnco } from "./engine.ts";

const BANNER = "== Type :q to end session. Type :n / :p to page. ==\n";

/**
 * anco session を模したフェイクプロセス。stdin への書き込み・flush 回数を記録し、
 * stdout はテストが `push` した文字列を readLoop へ流す。IPC 往復数の観測に使う。
 */
function makeFakeAnco(): {
  spawn: SpawnAnco;
  writes: string[];
  flushes: () => number;
  spawned: () => boolean;
  push: (text: string) => void;
} {
  const writes: string[] = [];
  let flushCount = 0;
  let spawned = false;
  let closed = false;
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let notify: (() => void) | null = null;

  const push = (text: string): void => {
    chunks.push(encoder.encode(text));
    const n = notify;
    notify = null;
    n?.();
  };

  async function* stdout(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const chunk = chunks.shift();
      if (chunk !== undefined) {
        yield chunk;
        continue;
      }
      if (closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }

  const spawn: SpawnAnco = () => {
    spawned = true;
    const proc: AncoProcess = {
      stdin: {
        write: (chunk: string) => {
          writes.push(chunk);
          return chunk.length;
        },
        flush: () => {
          flushCount += 1;
          return 0;
        },
        end: () => {
          closed = true;
          notify?.();
          return 0;
        },
      },
      stdout: stdout(),
      // 実プロセスの exited は解決しない前提（close で明示終了）
      exited: new Promise<number>(() => {}),
      kill: () => {
        closed = true;
        notify?.();
      },
    };
    return proc;
  };

  return { spawn, writes, flushes: () => flushCount, spawned: () => spawned, push };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

describe("AncoEngine の IPC バッチ送信（issue #34）", () => {
  test("文脈ありの 1 変換で :c/:ctx/かな を 1 往復に畳む", async () => {
    const fake = makeFakeAnco();
    const engine = new AncoEngine("/fake/anco", undefined, fake.spawn);

    const result = engine.convert("かな", "ぶんみゃく");

    // 起動バナー（pending 設定後）を返す
    await waitFor(() => fake.spawned());
    fake.push(BANNER);

    // バッチ書き込みが揃うまで待つ: :c → :ctx → かな の 3 行
    await waitFor(() => fake.writes.length >= 3);
    expect(fake.writes).toEqual([":c\n", ":ctx ぶんみゃく\n", "かな\n"]);
    // 3 コマンドを 1 回の flush でまとめて送る = IPC 往復は 1
    expect(fake.flushes()).toBe(1);

    // :c ブロック → :ctx ブロック → かなブロック（候補 + バナー）
    fake.push(BANNER);
    fake.push(BANNER);
    fake.push(`かな\n0. 仮名\n1. 仮\nTime: 0.010\n${BANNER}`);

    const candidates = (await result)._unsafeUnwrap();
    expect(candidates[0]).toBe("仮名");
    expect(candidates).toEqual(["仮名", "仮"]);

    engine.close();
  });

  test("文脈なしの 1 変換は :c/かな の 2 コマンドを 1 往復で送る", async () => {
    const fake = makeFakeAnco();
    const engine = new AncoEngine("/fake/anco", undefined, fake.spawn);

    const result = engine.convert("かな");

    await waitFor(() => fake.spawned());
    fake.push(BANNER);

    await waitFor(() => fake.writes.length >= 2);
    expect(fake.writes).toEqual([":c\n", "かな\n"]);
    expect(fake.flushes()).toBe(1);

    fake.push(BANNER);
    fake.push(`かな\n0. 仮名\nTime: 0.008\n${BANNER}`);

    expect((await result)._unsafeUnwrap()[0]).toBe("仮名");
    engine.close();
  });

  test("2 回の変換で往復数は変換あたり 1（起動除く）", async () => {
    const fake = makeFakeAnco();
    const engine = new AncoEngine("/fake/anco", undefined, fake.spawn);

    const first = engine.convert("いち");
    await waitFor(() => fake.spawned());
    fake.push(BANNER);
    await waitFor(() => fake.writes.length >= 2);
    fake.push(BANNER);
    fake.push(`いち\n0. 一\nTime: 0.005\n${BANNER}`);
    expect((await first)._unsafeUnwrap()[0]).toBe("一");
    expect(fake.flushes()).toBe(1);

    const second = engine.convert("に");
    await waitFor(() => fake.writes.length >= 4);
    fake.push(BANNER);
    fake.push(`に\n0. 二\nTime: 0.005\n${BANNER}`);
    expect((await second)._unsafeUnwrap()[0]).toBe("二");
    // 2 変換で flush は計 2（変換 1 回 = 1 往復）
    expect(fake.flushes()).toBe(2);

    engine.close();
  });

  test("改行を含むかなはエラー（プロセスを起動しない）", async () => {
    const fake = makeFakeAnco();
    const engine = new AncoEngine("/fake/anco", undefined, fake.spawn);
    const result = await engine.convert("ふく\nすう");
    expect(result.isErr()).toBe(true);
    expect(fake.spawned()).toBe(false);
    engine.close();
  });
});
