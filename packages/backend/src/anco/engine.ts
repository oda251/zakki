import type { Subprocess } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { errAsync, ResultAsync } from "neverthrow";
import type { EngineError, KanaKanjiEngine } from "@zakki/core/conversion/engine.ts";
import { identityEngine } from "@zakki/core/conversion/engine.ts";
import { errorMessage } from "@zakki/core/util/error.ts";
import { xdgDataHome } from "@zakki/data/util/paths.ts";
import { isBannerLine, parseCandidates, stripAnsi } from "./protocol.ts";

const REQUEST_TIMEOUT_MS = 15_000;

/** 候補ローテーション（手動修正 UX）に使う n-best の数 */
const CANDIDATE_COUNT = 5;

/** anco バイナリの場所。ZAKKI_ANCO_PATH で上書き可能（Docker 等で /opt に焼く用） */
export function defaultAncoPath(): string {
  return process.env["ZAKKI_ANCO_PATH"] ?? join(xdgDataHome(), "zakki", "anco", "anco");
}

/** zenz GGUF の場所。ZAKKI_ZENZ_PATH で上書き可能 */
export function defaultZenzPath(): string {
  return (
    process.env["ZAKKI_ZENZ_PATH"] ??
    join(xdgDataHome(), "zakki", "models", "zenz-v3.1-small-Q5_K_M.gguf")
  );
}

/**
 * 環境からのエンジン解決（TUI / web サーバの合成点が共有）。
 * anco 未導入なら identity（かな素通し）へフォールバックし、zenz GGUF があれば文脈校正を有効化。
 */
export function resolveDefaultEngine(): KanaKanjiEngine {
  const ancoPath = defaultAncoPath();
  if (!existsSync(ancoPath)) return identityEngine;
  const zenzPath = defaultZenzPath();
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
  lines: string[];
  timer: ReturnType<typeof setTimeout>;
}

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
  private proc: Subprocess<"pipe", "pipe", "ignore"> | null = null;
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: PendingRequest | null = null;
  private buffer = "";

  private readonly ancoPath: string;
  /** zenz GGUF のパス。指定すると文脈校正（Zenzai）が有効になる */
  private readonly zenzPath?: string;

  constructor(ancoPath: string = defaultAncoPath(), zenzPath?: string) {
    this.ancoPath = ancoPath;
    this.zenzPath = zenzPath;
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
    await this.send(":c");
    if (leftContext !== undefined && leftContext !== "") {
      await this.send(`:ctx ${lastLine(leftContext)}`);
    }
    const lines = await this.send(kana);
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
    this.proc = Bun.spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    void this.proc.exited.then(() => {
      this.failPending(new Error("anco session exited"));
      this.proc = null;
      this.ready = null;
    });
    void this.readLoop();
    // 最初のバナー行 = 起動完了
    return this.waitForBanner().then(() => {});
  }

  private waitForBanner(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        lines: [],
        timer: setTimeout(
          () => this.failPending(new Error("anco response timeout")),
          REQUEST_TIMEOUT_MS,
        ),
      };
    });
  }

  private send(line: string): Promise<string[]> {
    const proc = this.proc;
    if (proc === null) {
      return Promise.reject(new Error("anco session is not running"));
    }
    const response = this.waitForBanner();
    void proc.stdin.write(`${line}\n`);
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
      clearTimeout(pending.timer);
      this.pending = null;
      pending.resolve(pending.lines);
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
