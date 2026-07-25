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

/** spawn 1 回ごとに独立した fake プロセスを生成するプール（再起動・レース系の観測用） */
interface FakeProcHandle {
  writes: string[];
  push: (text: string) => void;
  killed: () => boolean;
  /** exited を解決し stdout を閉じる（プロセス死亡の模擬）。kill() とは独立に呼べる */
  exit: () => void;
}

function makeFakeAncoPool(): { spawn: SpawnAnco; procs: FakeProcHandle[] } {
  const procs: FakeProcHandle[] = [];
  const spawn: SpawnAnco = () => {
    const writes: string[] = [];
    let killed = false;
    let closed = false;
    const chunks: Uint8Array[] = [];
    const encoder = new TextEncoder();
    let notify: (() => void) | null = null;
    let resolveExited: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });

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

    const exit = (): void => {
      closed = true;
      const n = notify;
      notify = null;
      n?.();
      resolveExited();
    };

    const proc: AncoProcess = {
      stdin: {
        write: (chunk: string) => {
          writes.push(chunk);
          return chunk.length;
        },
        flush: () => 0,
        end: () => {
          exit();
          return 0;
        },
      },
      stdout: stdout(),
      exited,
      // kill は記録のみ（exited の解決タイミングをテスト側で制御し、遅延発火を模擬する）
      kill: () => {
        killed = true;
      },
    };
    procs.push({ writes, push, killed: () => killed, exit });
    return proc;
  };
  return { spawn, procs };
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

/** 1 回目の convert を応答なしでタイムアウトさせ、Err で終わることを確認する（各テストの前段） */
async function timeoutFirstConvert(
  pool: ReturnType<typeof makeFakeAncoPool>,
  engine: AncoEngine,
): Promise<void> {
  const first = engine.convert("いち");
  await waitFor(() => pool.procs.length === 1);
  pool.procs[0]?.push(BANNER); // 起動完了
  await waitFor(() => (pool.procs[0]?.writes.length ?? 0) >= 2);
  expect((await first).isErr()).toBe(true);
}

describe("AncoEngine の異常系リカバリ（issue #85）", () => {
  test("タイムアウト時に pending を reject し旧プロセスを kill する", async () => {
    const pool = makeFakeAncoPool();
    const engine = new AncoEngine("/fake/anco", undefined, pool.spawn, 30);

    const result = engine.convert("かな");
    await waitFor(() => pool.procs.length === 1);
    pool.procs[0]?.push(BANNER); // 起動完了
    await waitFor(() => (pool.procs[0]?.writes.length ?? 0) >= 2);

    // 応答を返さない → タイムアウト
    const res = await result;
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().message).toContain("timeout");
    expect(pool.procs[0]?.killed()).toBe(true);

    engine.close();
  });

  test("タイムアウト後の次の convert で新プロセスを spawn し正常に候補を返す", async () => {
    const pool = makeFakeAncoPool();
    const engine = new AncoEngine("/fake/anco", undefined, pool.spawn, 30);

    // 1 回目: 応答なしでタイムアウトさせる
    await timeoutFirstConvert(pool, engine);

    // 2 回目: 新プロセスが spawn され、クリーンに応答できる
    const second = engine.convert("に");
    await waitFor(() => pool.procs.length === 2);
    pool.procs[1]?.push(BANNER); // 新プロセスの起動バナー
    await waitFor(() => (pool.procs[1]?.writes.length ?? 0) >= 2);
    expect(pool.procs[1]?.writes).toEqual([":c\n", "に\n"]);
    pool.procs[1]?.push(BANNER);
    pool.procs[1]?.push(`に\n0. 二\nTime: 0.005\n${BANNER}`);
    expect((await second)._unsafeUnwrap()).toEqual(["二"]);

    engine.close();
  });

  test("タイムアウト後に旧プロセスの遅延応答が届いても次リクエストと混線しない", async () => {
    const pool = makeFakeAncoPool();
    const engine = new AncoEngine("/fake/anco", undefined, pool.spawn, 30);

    // 1 回目: 応答なしでタイムアウトさせる（旧プロセスは kill 済みだが stdout は生きている想定）
    await timeoutFirstConvert(pool, engine);

    // 2 回目を開始し、新プロセスの起動バナーを返す
    const second = engine.convert("に");
    await waitFor(() => pool.procs.length === 2);
    pool.procs[1]?.push(BANNER);
    await waitFor(() => (pool.procs[1]?.writes.length ?? 0) >= 2);

    // ここで旧プロセスの遅延応答（:c ブロック + 候補ブロック）が届く
    pool.procs[0]?.push(BANNER);
    pool.procs[0]?.push(`いち\n0. 一\nTime: 0.005\n${BANNER}`);

    // 新プロセスの正しい応答だけが second に対応づくこと
    pool.procs[1]?.push(BANNER);
    pool.procs[1]?.push(`に\n0. 二\nTime: 0.005\n${BANNER}`);
    expect((await second)._unsafeUnwrap()).toEqual(["二"]);

    engine.close();
  });

  test("行の途中でプロセスが死んだ後の再起動で旧バッファ残渣が混入しない", async () => {
    const pool = makeFakeAncoPool();
    const engine = new AncoEngine("/fake/anco", undefined, pool.spawn, 500);

    // 1 回目: 改行なしの中途出力を残したままプロセスが死ぬ
    const first = engine.convert("いち");
    await waitFor(() => pool.procs.length === 1);
    pool.procs[0]?.push(BANNER);
    await waitFor(() => (pool.procs[0]?.writes.length ?? 0) >= 2);
    pool.procs[0]?.push("0. 途中"); // 改行なし → buffer に残渣が残る
    // 中途チャンクが readLoop に消費されるのを待ってからプロセスを殺す
    await new Promise((resolve) => setTimeout(resolve, 10));
    pool.procs[0]?.exit();
    expect((await first).isErr()).toBe(true);

    // 2 回目: 新プロセスの先頭バナーが残渣と連結されず、起動・応答が正常に完了する
    const second = engine.convert("に");
    await waitFor(() => pool.procs.length === 2);
    pool.procs[1]?.push(BANNER);
    await waitFor(() => (pool.procs[1]?.writes.length ?? 0) >= 2);
    pool.procs[1]?.push(BANNER);
    pool.procs[1]?.push(`に\n0. 二\nTime: 0.005\n${BANNER}`);
    expect((await second)._unsafeUnwrap()).toEqual(["二"]);

    engine.close();
  });

  test("kill 後に旧プロセスの exited が遅延発火しても新プロセスを巻き込まない", async () => {
    const pool = makeFakeAncoPool();
    const engine = new AncoEngine("/fake/anco", undefined, pool.spawn, 30);

    // 1 回目: タイムアウト → kill（exited はまだ解決しない）
    await timeoutFirstConvert(pool, engine);
    expect(pool.procs[0]?.killed()).toBe(true);

    // 2 回目: 新プロセスが起動して応答待ちに入る
    const second = engine.convert("に");
    await waitFor(() => pool.procs.length === 2);
    pool.procs[1]?.push(BANNER);
    await waitFor(() => (pool.procs[1]?.writes.length ?? 0) >= 2);

    // ここで旧プロセスの exited が遅延発火する（kill の後始末）
    pool.procs[0]?.exit();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 新プロセスの pending は巻き込まれず、応答が正常に返ること
    pool.procs[1]?.push(BANNER);
    pool.procs[1]?.push(`に\n0. 二\nTime: 0.005\n${BANNER}`);
    expect((await second)._unsafeUnwrap()).toEqual(["二"]);

    // proc / ready が null 上書きされていない = 3 回目でも spawn は増えない
    const third = engine.convert("さん");
    await waitFor(() => (pool.procs[1]?.writes.length ?? 0) >= 4);
    expect(pool.procs.length).toBe(2);
    pool.procs[1]?.push(BANNER);
    pool.procs[1]?.push(`さん\n0. 三\nTime: 0.005\n${BANNER}`);
    expect((await third)._unsafeUnwrap()).toEqual(["三"]);

    engine.close();
  });
});
