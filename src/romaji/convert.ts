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

const HIRAGANA_OR_CHOON = /[ぁ-ゖー]/;

export function convertRomaji(input: string, options: ConvertOptions = {}): ConvertResult {
  const flush = options.flush ?? false;
  let out = "";
  let i = 0;

  while (i < input.length) {
    const c = input.charAt(i);

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
      i = j;
      continue;
    }

    // ローマ字テーブル最長一致
    const matched = matchTable(input, i);
    if (matched !== null) {
      out += matched.kana;
      i += matched.length;
      continue;
    }

    const next = input.charAt(i + 1);

    // ん: n + (子音 | 単語外) → ん。n' → ん。末尾の nn → ん
    if (c === "n") {
      if (next === "'") {
        out += "ん";
        i += 2;
        continue;
      }
      if (next === "n" && i + 2 >= input.length && flush) {
        out += "ん";
        i += 2;
        continue;
      }
      // n の次が子音（n 自身を含む。"onna" → おんな）または単語外文字なら ん
      if (next !== "" && (CONSONANT.test(next) || next === "n" || !WORD_CHAR.test(next))) {
        out += "ん";
        i += 1;
        continue;
      }
      // 末尾の孤立 n（次の打鍵で な行 にも ん にもなりうる）
      if (next === "") {
        if (flush) {
          out += "ん";
          i += 1;
          continue;
        }
        return { converted: out, pending: input.slice(i) };
      }
    }

    // 促音: 同一子音の連続（nn を除く）→ っ
    if (CONSONANT.test(c) && next === c && c !== "n") {
      out += "っ";
      i += 1;
      continue;
    }
    // 促音: tch → っ + ch...（matcha → まっちゃ）
    if (c === "t" && input.startsWith("ch", i + 1)) {
      out += "っ";
      i += 1;
      continue;
    }

    // 末尾の打鍵途中（k, ky, sh, xts など）は pending として保留
    if (KEY_PREFIXES.has(input.slice(i)) && !flush) {
      return { converted: out, pending: input.slice(i) };
    }

    // 句読点・長音: 直前がかなのときのみ全角へ写像（"3.14" 等を壊さない）
    const punct = PUNCT_MAP.get(c);
    if (punct !== undefined && HIRAGANA_OR_CHOON.test(out.slice(-1))) {
      out += punct;
      i += 1;
      continue;
    }

    // どの規則にも該当しない文字は素通し
    out += c;
    i += 1;
  }

  return { converted: out, pending: "" };
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
