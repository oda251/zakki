import { PASTE_OPEN, pasteBlockEnd } from "@zakki/core/conversion/paste.ts";
import { KEY_PREFIXES, MAX_KEY_LENGTH, ROMAJI_TABLE } from "./table.ts";

export interface ConvertOptions {
  /**
   * true のとき末尾の打鍵途中ローマ字を確定させる（孤立 n → ん、その他は素通し）。
   * チャンク確定時などストリームの終端で使う。
   */
  flush?: boolean;
}

export interface ConvertResult {
  /** 確定済みのかな交じりテキスト */
  converted: string;
  /** 末尾の打鍵途中ローマ字（次の入力で解決される。flush 時は常に空） */
  pending: string;
}

const UPPER = /[A-Z]/;
const CONSONANT = /[bcdfghjklmpqrstvwxyz]/;
const WORD_CHAR = /[A-Za-z0-9]/;

// 仕様（docs/CONCEPT.md §1）:
// - 大文字で始まる単語は英単語としてかな変換しない
// - 英単語は英数字の連続として継続し、スペース・記号で終端する
// - 英単語直後のスペース 1 個は区切りとして消費する（"Claude ga" → "Claudeが"）
const PUNCT_MAP: ReadonlyMap<string, string> = new Map([
  [",", "、"],
  [".", "。"],
  ["-", "ー"],
]);

// 文区切り（。！？ と そのローマ字 . ! ?）。各文字を採用する全角形へ写像する。
// 連続したら最後の 1 つだけ採用してマージする（"あ。。" → "あ。"、"あ。！" → "あ！"）。
const SENTENCE_DELIMS: ReadonlyMap<string, string> = new Map([
  [".", "。"],
  ["。", "。"],
  ["!", "！"],
  ["！", "！"],
  ["?", "？"],
  ["？", "？"],
]);
const FULLWIDTH_DELIM = /[。！？]/;

const HIRAGANA_OR_CHOON = /[ぁ-ゖー]/;

/** 入力を消費して生成した 1 表示単位。削除（かな単位 backspace）の境界に使う */
type UnitKind = "kana" | "english" | "passthrough" | "paste";

interface Unit {
  /** input 内の開始位置 */
  start: number;
  kind: UnitKind;
}

interface ScanResult {
  converted: string;
  pending: string;
  /** 生成順の単位（pending は含まない） */
  units: Unit[];
}

/**
 * ローマ字ストリームを左→右最長一致で消費し、かな・単位境界を求める中核。
 * convertRomaji と deleteLastUnit が共有する（境界の二重実装を避ける）。
 */
function scan(input: string, flush: boolean): ScanResult {
  let out = "";
  let i = 0;
  const units: Unit[] = [];

  while (i < input.length) {
    const start = i;
    const c = input.charAt(i);

    // ペースト領域: PASTE_OPEN … PASTE_CLOSE を変換せずそのまま 1 単位として通す
    if (c === PASTE_OPEN) {
      const end = pasteBlockEnd(input, i);
      out += input.slice(i, end);
      units.push({ start, kind: "paste" });
      i = end;
      continue;
    }

    // 英単語モード: 大文字始まりの英数字列をそのまま通す
    if (UPPER.test(c)) {
      let j = i;
      while (j < input.length && WORD_CHAR.test(input.charAt(j))) {
        j++;
      }
      out += input.slice(i, j);
      // 直後のスペース 1 個は区切りとして消費（連続スペースは 1 個減る）
      if (input.charAt(j) === " ") {
        j++;
      }
      units.push({ start, kind: "english" });
      i = j;
      continue;
    }

    // ローマ字テーブル最長一致
    const matched = matchTable(input, i);
    if (matched !== null) {
      out += matched.kana;
      units.push({ start, kind: "kana" });
      i += matched.length;
      continue;
    }

    const next = input.charAt(i + 1);

    // 撥音 ん の処理（docs/CONCEPT.md §1）
    if (c === "n") {
      if (next === "'") {
        // n' は明示的な ん
        out += "ん";
        units.push({ start, kind: "kana" });
        i += 2;
        continue;
      }
      if (next === "n") {
        // nn は後続によらず常に 1 つの ん（nn → ん、nna → んあ、nnka → んか）。
        // ん＋な行は n を重ねて打つ（nnna → んな）。ん＋母音もこれで自然に出る
        // （rennai → れんあい）。打ち分けの流儀として nn=ん を採用する。
        out += "ん";
        units.push({ start, kind: "kana" });
        i += 2;
        continue;
      }
      // n + 子音 / 記号など単語外 → ん（1 文字消費）
      if (next !== "" && (CONSONANT.test(next) || !WORD_CHAR.test(next))) {
        out += "ん";
        units.push({ start, kind: "kana" });
        i += 1;
        continue;
      }
      // 末尾の孤立 n は次打鍵で な行 にも ん にもなりうるため保留
      if (next === "") {
        if (flush) {
          out += "ん";
          units.push({ start, kind: "kana" });
          i += 1;
          continue;
        }
        return { converted: out, pending: input.slice(i), units };
      }
    }

    // 促音: 同一子音の連続（nn を除く）→ っ
    if (CONSONANT.test(c) && next === c && c !== "n") {
      out += "っ";
      units.push({ start, kind: "kana" });
      i += 1;
      continue;
    }
    // 促音: tch → っ + ch...（matcha → まっちゃ）
    if (c === "t" && input.startsWith("ch", i + 1)) {
      out += "っ";
      units.push({ start, kind: "kana" });
      i += 1;
      continue;
    }

    // 末尾の打鍵途中（k, ky, sh, xts など）は pending として保留
    if (KEY_PREFIXES.has(input.slice(i)) && !flush) {
      return { converted: out, pending: input.slice(i), units };
    }

    // 文区切り（。！？）: 直前がかな、または既に全角区切りのとき採用する
    // （"3.14" 等を壊さない）。連続した区切りは読み進め、最後の 1 つだけ採用する。
    const delim = SENTENCE_DELIMS.get(c);
    if (delim !== undefined && (HIRAGANA_OR_CHOON.test(out.slice(-1)) || FULLWIDTH_DELIM.test(c))) {
      let j = i + 1;
      let lastMapped = delim;
      for (let nextDelim = SENTENCE_DELIMS.get(input.charAt(j)); nextDelim !== undefined; ) {
        lastMapped = nextDelim;
        j += 1;
        nextDelim = SENTENCE_DELIMS.get(input.charAt(j));
      }
      out += lastMapped;
      units.push({ start, kind: "kana" });
      i = j;
      continue;
    }

    // 句読点・長音（、ー）: 直前がかなのときのみ全角へ写像（"3.14" 等を壊さない）
    const punct = PUNCT_MAP.get(c);
    if (punct !== undefined && HIRAGANA_OR_CHOON.test(out.slice(-1))) {
      out += punct;
      units.push({ start, kind: "kana" });
      i += 1;
      continue;
    }

    // どの規則にも該当しない文字は素通し
    out += c;
    units.push({ start, kind: "passthrough" });
    i += 1;
  }

  return { converted: out, pending: "", units };
}

export function convertRomaji(input: string, options: ConvertOptions = {}): ConvertResult {
  const { converted, pending } = scan(input, options.flush ?? false);
  return { converted, pending };
}

/**
 * 末尾を 1 つ削除した raw を返す（backspace 用）。
 * - 打鍵途中ローマ字（pending）が残るときは 1 文字だけ削る
 * - 確定したかな単位（か=ka, きゃ=kya 等の 1 モーラ）はそのローマ字スパンごと削る
 * - 英単語は 1 文字ずつ削る（かな変換対象外のため）
 * - ペースト塊は 1 単位としてまとめて削る
 */
export function deleteLastUnit(input: string): string {
  if (input === "") {
    return "";
  }
  const { pending, units } = scan(input, false);
  if (pending !== "") {
    return input.slice(0, -1);
  }
  const last = units.at(-1);
  if (last === undefined || last.kind === "english" || last.kind === "passthrough") {
    return input.slice(0, -1);
  }
  return input.slice(0, last.start);
}

function matchTable(input: string, start: number): { kana: string; length: number } | null {
  const max = Math.min(MAX_KEY_LENGTH, input.length - start);
  for (let len = max; len >= 1; len--) {
    const kana = ROMAJI_TABLE.get(input.slice(start, start + len));
    if (kana !== undefined) {
      return { kana, length: len };
    }
  }
  return null;
}
