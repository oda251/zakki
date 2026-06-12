/**
 * anco session（ライン指向プロトコル）の出力パース。
 * 仕様の根拠: AzooKeyKanaKanjiConverter v0.11.2 Sources/CliTool/Subcommands/SessionCommand.swift
 * - 入力 1 行ごとに「かなエコー行」「`<i>. <候補>` 行 × top_n」「`Time: <秒>` 行」が出る
 * - 出力には bold 等の ANSI エスケープが混じるため除去してからパースする
 */

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

const CANDIDATE_LINE = /^(\d+)\. (.*)$/;
const TIME_LINE = /^Time: /;
const BANNER_LINE = /^== Type :q to end session/;

export interface SessionResponse {
  candidates: string[];
}

/**
 * 1 リクエスト分の出力ブロック（Time: 行まで）から候補を抽出する。
 * 行は ANSI 除去済みであること。
 */
export function parseCandidates(lines: string[]): SessionResponse {
  const candidates: string[] = [];
  for (const line of lines) {
    const m = CANDIDATE_LINE.exec(line);
    if (m !== null && m[2] !== undefined) {
      candidates[Number(m[1])] = m[2];
    }
  }
  return { candidates };
}

export function isTimeLine(line: string): boolean {
  return TIME_LINE.test(line);
}

export function isBannerLine(line: string): boolean {
  return BANNER_LINE.test(line);
}
