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

/**
 * フッターの気分ドット（●）の色。ポジ=赤 / ネガ=青 / 中立=グレー。
 * 絵文字は端末との幅計算ズレで表示が崩れるため、色付きの細い ● で表す。
 */
const MOOD_COLOR: Record<Mood, string> = {
  positive: "#cf8f8f",
  negative: "#8fa8cf",
  neutral: "#999999",
};

export function moodColor(score: number): string {
  return MOOD_COLOR[moodOf(score)];
}

/** 極性スコアを符号付き小数文字列に整形する（例: "+0.42", "-0.10", "null → "-"）  */
export function fmtPolarity(score: number | null): string {
  if (score === null) return "-";
  return `${score >= 0 ? "+" : ""}${score.toFixed(2)}`;
}
