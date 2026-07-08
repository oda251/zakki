import { existsSync } from "node:fs";
import { join } from "node:path";
import { errAsync, ResultAsync } from "neverthrow";
import type { EngineError, KanaKanjiEngine } from "@zakki/core/conversion/engine.ts";
import { identityEngine } from "@zakki/core/conversion/engine.ts";
import { errorMessage } from "@zakki/core/util/error.ts";
import { APP_DIR } from "@zakki/data/util/app-dir.ts";
import { isBannerLine, parseCandidates, stripAnsi } from "./protocol.ts";

const REQUEST_TIMEOUT_MS = 15_000;

/** 候補ローテーション（手動修正 UX）に使う n-best の数 */
const CANDIDATE_COUNT = 5;

/** anco バイナリの既定の場所。dataHome は解決済みの XDG データディレクトリ */
export function defaultAncoPath(dataHome: string): string {
  return join(dataHome, APP_DIR, "anco", "anco");
}

/** zenz GGUF の既定の場所 */
export function defaultZenzPath(dataHome: string): string {
  return join(dataHome, APP_DIR, "models", "zenz-v3.1-small-Q5_K_M.gguf");
}

/** 検証済み config からの上書き値（ZAKKI_ANCO_PATH / ZAKKI_ZENZ_PATH 由来） */
export interface EngineOverrides {
  /** anco バイナリの上書き（Docker 等で /opt に焼く用） */
  readonly ancoPath?: string;
  /** zenz GGUF の上書き */
  readonly zenzPath?: string;
}

/**
 * 環境からのエンジン解決（TUI / web サーバの合成点が共有）。
 * anco 未導入なら identity（かな素通し）へフォールバックし、zenz GGUF があれば文脈校正を有効化。
 */
export function resolveDefaultEngine(env: EngineOverrides, dataHome: string): KanaKanjiEngine {
  const ancoPath = env.ancoPath ?? defaultAncoPath(dataHome);
  if (!existsSync(ancoPath)) return identityEngine;
  const zenzPath = env.zenzPath ?? defaultZenzPath(dataHome);
  return new AncoEngine(ancoPath, existsSync(zenzPath) ? zenzPath : undefined);
}

const toEngineError = (cause: unknown): EngineError => ({
  type: "engine-error",
  message: errorMessage(cause),
  cause,
});

interface PendingRequest {
  resolve: (lines: string[]) => void;
  reject: (cause: unknown) => void;
  /** 現在読み取り中のブロック（直前のバナー以降の行）。最終ブロックだけを resolve に渡す */
  lines: string[];
  /** 完了までに残り消費するバナー数。バッチ送信では 1 コマンド 1 バナー */
  bannersRemaining: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * anco session の外部プロセス最小 IF（テストでモック差し替え可能にする境界）。
 * 実体は Bun.spawn の Subprocess（stdin=FileSink / stdout=ReadableStream）が構造的に満たす。
 */
export interface AncoProcess {
  readonly stdin: {
    write(chunk: string): unknown;
    flush(): unknown;
    end(): unknown;
  };
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly exited: Promise<unknown>;
  kill(): void;
}

/** 引数配列を受けて anco session プロセスを起動する関数（既定は Bun.spawn） */
export type SpawnAnco = (args: string[]) => AncoProcess;

const defaultSpawn: SpawnAnco = (args) =>
  Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });

/**
 * anco session を常駐外部プロセスとして保持する KanaKanjiEngine 実装
 * （docs/FEATURES.md §変換エンジン）。リクエストは 1 本のセッションへ直列化する。
 *
 * フレーミング: session はループ先頭で毎回バナー行
 * 「== Type :q to end session ...==」を出力する（SessionCommand.swift）。
 * したがって「書き込み 1 行への応答」は次のバナー行までの全行であり、
 * `:c` / `:ctx` のように `Time:` 行を出さないコマンドもこれで区切れる。
 * 変換ごとに `:c` でコンポジションと文脈を破棄し、左文脈は `:ctx` で与え直す。
 */
export class AncoEngine implements KanaKanjiEngine {
  readonly name: string;
  private proc: AncoProcess | null = null;
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: PendingRequest | null = null;
  private buffer = "";

  private readonly ancoPath: string;
  /** zenz GGUF のパス。指定すると文脈校正（Zenzai）が有効になる */
  private readonly zenzPath?: string;
  private readonly spawn: SpawnAnco;

  constructor(ancoPath: string, zenzPath?: string, spawn: SpawnAnco = defaultSpawn) {
    this.ancoPath = ancoPath;
    this.zenzPath = zenzPath;
    this.spawn = spawn;
    this.name = zenzPath === undefined ? "anco" : "anco+zenz";
  }

  convert(kana: string, leftContext?: string): ResultAsync<string[], EngineError> {
    if (kana.includes("\n")) {
      return errAsync(toEngineError(new Error("kana must be a single line")));
    }
    // 直列化: 前のリクエストの完了（成否問わず）を待ってから送る
    const task = this.queue.then(() => this.request(kana, leftContext));
    this.queue = task.catch(() => {});
    return ResultAsync.fromPromise(task, toEngineError);
  }

  close(): void {
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    if (proc !== null) {
      try {
        void proc.stdin.write(":q\n");
        void proc.stdin.end();
      } catch {
        proc.kill();
      }
    }
  }

  private async request(kana: string, leftContext?: string): Promise<string[]> {
    await this.ensureStarted();
    // `:c`（コンポジション+文脈リセット）→ `:ctx`（左文脈）→ かな を 1 バッチで書き込み、
    // バナー区切りの応答をまとめて 1 往復で読む。session は 1 コマンドごとに必ずバナーを
    // 返す（loop 先頭で毎回出力）ため、コマンド数 = 消費バナー数として畳める。
    // これで 1 変換あたりの IPC 往復を 3（文脈あり）/ 2（文脈なし）→ 1 に削減する（issue #34）。
    // なお anco プロトコルはコンテキストとかなを 1 メッセージに合成する形式を持たない
    // （`:ctx <前文>` と かな入力は別々の行コマンド。docs/RESEARCH.md §1 / protocol.ts）ため、
    // バイナリ非改変の範囲では「往復の畳み込み」が最大の削減になる。
    const commands = [":c"];
    if (leftContext !== undefined && leftContext !== "") {
      commands.push(`:ctx ${lastLine(leftContext)}`);
    }
    commands.push(kana);
    const lines = await this.sendBatch(commands);
    const { candidates } = parseCandidates(lines);
    if (candidates.length === 0 || candidates[0] === undefined) {
      throw new Error(`anco returned no candidate for: ${kana}`);
    }
    return candidates.filter((c): c is string => c !== undefined);
  }

  private ensureStarted(): Promise<void> {
    if (this.ready === null) {
      this.ready = this.start();
    }
    return this.ready;
  }

  private start(): Promise<void> {
    // stdbuf -oL は必須: anco の stdout は pipe 接続時に全面バッファリングされ、
    // exit までバナーも候補も届かない（WSL2 + Bun.spawn 実測）。coreutils 前提（Linux）
    const args = [
      "stdbuf",
      "-oL",
      this.ancoPath,
      "session",
      "-n",
      String(CANDIDATE_COUNT),
      "--disable_prediction",
    ];
    if (this.zenzPath !== undefined) {
      args.push("--zenz", this.zenzPath, "--zenz_v3");
    }
    this.proc = this.spawn(args);
    void this.proc.exited.then(() => {
      this.failPending(new Error("anco session exited"));
      this.proc = null;
      this.ready = null;
    });
    void this.readLoop();
    // 最初のバナー行 = 起動完了
    return this.waitForBanners(1).then(() => {});
  }

  /** 残り `count` 個のバナーを消費するまで待ち、最終ブロックの行を返す */
  private waitForBanners(count: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        lines: [],
        bannersRemaining: count,
        timer: setTimeout(
          () => this.failPending(new Error("anco response timeout")),
          REQUEST_TIMEOUT_MS,
        ),
      };
    });
  }

  /**
   * 複数コマンドをまとめて書き込み、コマンド数分のバナーを 1 往復で読む。
   * 中間ブロック（`:c` / `:ctx` の応答）は破棄し、最終コマンド（かな）の候補行だけを返す。
   */
  private sendBatch(commands: readonly string[]): Promise<string[]> {
    const proc = this.proc;
    if (proc === null) {
      return Promise.reject(new Error("anco session is not running"));
    }
    const response = this.waitForBanners(commands.length);
    for (const line of commands) {
      void proc.stdin.write(`${line}\n`);
    }
    void proc.stdin.flush();
    return response;
  }

  private async readLoop(): Promise<void> {
    const proc = this.proc;
    if (proc === null) {
      return;
    }
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      this.buffer += decoder.decode(chunk, { stream: true });
      let index = this.buffer.indexOf("\n");
      while (index !== -1) {
        const line = stripAnsi(this.buffer.slice(0, index)).trimEnd();
        this.buffer = this.buffer.slice(index + 1);
        this.handleLine(line);
        index = this.buffer.indexOf("\n");
      }
    }
  }

  private handleLine(line: string): void {
    const pending = this.pending;
    if (pending === null) {
      return;
    }
    if (isBannerLine(line)) {
      pending.bannersRemaining -= 1;
      if (pending.bannersRemaining <= 0) {
        clearTimeout(pending.timer);
        this.pending = null;
        pending.resolve(pending.lines);
        return;
      }
      // 中間ブロックは破棄し、次のブロック（最終コマンドの応答）だけを残す
      pending.lines = [];
      return;
    }
    pending.lines.push(line);
  }

  private failPending(cause: unknown): void {
    const pending = this.pending;
    if (pending !== null) {
      clearTimeout(pending.timer);
      this.pending = null;
      pending.reject(cause);
    }
  }
}

/** :ctx は 1 行コマンドのため、複数行文脈は最終行だけを渡す */
function lastLine(text: string): string {
  return text.split("\n").at(-1) ?? "";
}
