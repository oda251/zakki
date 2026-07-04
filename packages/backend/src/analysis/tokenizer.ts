import { TokenizerBuilder } from "lindera-wasm-nodejs-ipadic";

/**
 * lindera-wasm（IPAdic 同梱、MIT）の薄いラッパ（docs/FEATURES.md §形態素解析・全文検索）。
 * 辞書ロードに約 1 秒かかるため遅延シングルトンにする。
 */

export interface Token {
  surface: string;
  /** 品詞（名詞・動詞など） */
  partOfSpeech: string;
  /** 品詞細分類 1（一般・固有名詞・非自立・数など） */
  subcategory: string;
  /** 読み（カタカナ）。未知語は undefined */
  reading: string | undefined;
}

interface LinderaToken {
  surface?: string;
  partOfSpeech?: string;
  partOfSpeechSubcategory1?: string;
  reading?: string;
}

let cached: { tokenize: (text: string) => LinderaToken[] } | null = null;

function tokenizer(): { tokenize: (text: string) => LinderaToken[] } {
  if (cached === null) {
    const builder = new TokenizerBuilder();
    builder.setDictionary("embedded://ipadic");
    builder.setMode("normal");
    cached = builder.build() as { tokenize: (text: string) => LinderaToken[] };
  }
  return cached;
}

export function tokenize(text: string): Token[] {
  if (text.trim() === "") {
    return [];
  }
  return tokenizer()
    .tokenize(text)
    .map((t) => ({
      surface: t.surface ?? "",
      partOfSpeech: t.partOfSpeech ?? "",
      subcategory: t.partOfSpeechSubcategory1 ?? "",
      reading: t.reading === "*" ? undefined : t.reading,
    }))
    .filter((t) => t.surface !== "");
}

/** タグ・関連付けの素材になる内容語（名詞）を抽出する。重複は保持（TF 計算用） */
const EXCLUDED_NOUN_SUBCATEGORIES = new Set(["非自立", "代名詞", "数", "接尾", "副詞可能"]);

export function extractNouns(text: string): string[] {
  return tokenize(text)
    .filter(
      (t) =>
        t.partOfSpeech === "名詞" &&
        !EXCLUDED_NOUN_SUBCATEGORIES.has(t.subcategory) &&
        t.surface.length >= 2,
    )
    .map((t) => t.surface);
}

/**
 * 本文の読みテキスト（カタカナ連結）。漢字を読みに開くことで、
 * かなクエリ（ローマ字入力）による全文検索を成立させる。
 * 読みのない語（英単語・記号など）は表層形をそのまま使う。
 */
export function readingText(text: string): string {
  return tokenize(text)
    .filter((t) => t.partOfSpeech !== "記号")
    .map((t) => t.reading ?? t.surface)
    .join("");
}

/** ひらがな→カタカナ（検索クエリの読み照合用） */
export function toKatakana(text: string): string {
  return text.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}
