import { analyzeNegaposi } from "negaposi";

/**
 * チャンク本文のネガポジ極性スコア [-1, +1]（docs/FEATURES.md §整理・想起系 10 感情分析）。
 * 日本語評価極性辞書（東北大 乾・岡崎研, negaposi に同梱・MIT）による決定的判定。
 * 一致語の極性の平均で、一致語が無ければ 0（中立）。モデル・LLM 不要でローカル完結。
 * 同一本文の再計算を避けるためプロセス内キャッシュする。
 */
const cache = new Map<string, number>();

export function scoreSentiment(text: string): number {
  const cached = cache.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const score = text.trim() === "" ? 0 : analyzeNegaposi({ text });
  cache.set(text, score);
  return score;
}

/** ニュートラルとみなす極性の絶対値の閾値（日次集計の分類にも使う） */
export const NEUTRAL_BAND = 0.1;

export type Mood = "positive" | "negative" | "neutral";

export function moodOf(score: number): Mood {
  if (score > NEUTRAL_BAND) {
    return "positive";
  }
  if (score < -NEUTRAL_BAND) {
    return "negative";
  }
  return "neutral";
}

const MOOD_LABEL: Record<Mood, string> = {
  positive: "😊 ポジティブ",
  negative: "😟 ネガティブ",
  neutral: "😐 ニュートラル",
};

/** スコアを気分ラベル＋絵文字へ（表示・ダイジェスト用） */
export function moodLabel(score: number): string {
  return MOOD_LABEL[moodOf(score)];
}

/** 情報量を絞った気分アイコン（フッター用）: ポジ 🔴 / ネガ 🔵 / 中立 ⚪ */
const MOOD_ICON: Record<Mood, string> = {
  positive: "🔴",
  negative: "🔵",
  neutral: "⚪",
};

export function moodIcon(score: number): string {
  return MOOD_ICON[moodOf(score)];
}

/** 極性スコアを符号付き小数文字列に整形する（例: "+0.42", "-0.10", "null → "-"）  */
export function fmtPolarity(score: number | null): string {
  if (score === null) return "-";
  return `${score >= 0 ? "+" : ""}${score.toFixed(2)}`;
}
