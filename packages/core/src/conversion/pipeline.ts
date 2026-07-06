import type { KanaKanjiEngine } from "./engine.ts";
import { segmentKana } from "@zakki/core/conversion/segment.ts";

const MAX_ATTEMPTS = 3;

export interface ApplyResult {
  /** 変換済みセグメントを置換した表示テキスト */
  text: string;
  /** 変換待ち（実行中含む）のセグメント数 */
  converting: number;
}

interface CacheEntry {
  /** 良い順の候補（先頭が最良）。学習済み修正は先頭に固定される */
  candidates: string[];
  /** 現在採用している候補の添字 */
  index: number;
}

export interface PipelineOptions {
  /** 学習済み手動修正（かな → 確定表記）。最優先候補として固定する */
  corrections?: ReadonlyMap<string, string>;
  /** 永続化済みの自動変換キャッシュ。起動時シード（corrections に劣後） */
  cache?: ReadonlyMap<string, string>;
  /** エンジン変換が確定するたびに呼ぶ（永続化用）。最良候補を渡す */
  onConverted?: (kana: string, converted: string) => void;
}

/**
 * 非同期かな漢字変換パイプライン（docs/CONCEPT.md §1）。
 *
 * 不変条件: 変換はタイピングを一切ブロックしない。apply() は同期で
 * 「現時点で変換できている表示」を返し、未変換の完結セグメントを
 * バックグラウンドでエンジンに投げる。変換が返ると onUpdate が呼ばれ、
 * 次の apply() で置換済みテキストが得られる（リアクティブ置換）。
 *
 * キャッシュはかなセグメント本文をキーにするため、編集（backspace）で
 * セグメントが変われば自動的に再変換され、同一文の再変換は走らない。
 * 文脈（直前セグメントの変換結果）は投入時点のものを渡す。
 *
 * 手動修正 UX（docs/FEATURES.md §変換の修正 UX）: rotate() が候補を
 * ローテーションし、確定値を onChosen で返す（呼び出し側が学習を永続化する）。
 * overrides（学習済み修正）はキャッシュの先頭候補として最優先される。
 */
export class ConversionPipeline {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly attempts = new Map<string, number>();
  private readonly inflight = new Set<string>();

  private readonly onConverted: (kana: string, converted: string) => void;
  private readonly engine: KanaKanjiEngine;
  private readonly onUpdate: () => void;
  private readonly onError: (message: string) => void;

  constructor(
    engine: KanaKanjiEngine,
    onUpdate: () => void,
    onError: (message: string) => void = () => {},
    options: PipelineOptions = {},
  ) {
    this.engine = engine;
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.onConverted = options.onConverted ?? (() => {});
    // キャッシュ → corrections の順にシードし、corrections を最優先にする
    for (const [kana, converted] of options.cache ?? []) {
      this.cache.set(kana, { candidates: [converted], index: 0 });
    }
    for (const [kana, chosen] of options.corrections ?? []) {
      this.cache.set(kana, { candidates: [chosen], index: 0 });
    }
  }

  apply(kana: string): ApplyResult {
    const segments = segmentKana(kana);
    let text = "";
    let converting = 0;
    let leftContext = "";
    for (const segment of segments) {
      if (segment.separator || !segment.complete) {
        text += segment.text;
        continue;
      }
      const chosen = this.chosenFor(segment.text);
      if (chosen !== null) {
        text += chosen;
        leftContext = chosen;
        continue;
      }
      converting += 1;
      this.enqueue(segment.text, leftContext);
      text += segment.text;
      leftContext = segment.text;
    }
    return { text, converting };
  }

  /**
   * かなセグメントの採用候補を次へ進める（1 キー手動修正）。
   * 候補リストが未取得（学習済み修正のみ等）の場合はエンジンへ取得しに行き、
   * 到着後にローテーションして onChosen を呼ぶ。
   */
  rotate(kana: string, onChosen: (chosen: string) => void): void {
    const entry = this.cache.get(kana);
    if (entry !== undefined && entry.candidates.length > 1) {
      entry.index = (entry.index + 1) % entry.candidates.length;
      const chosen = entry.candidates[entry.index];
      if (chosen !== undefined) {
        this.onUpdate();
        onChosen(chosen);
      }
      return;
    }
    // 候補リストがない: 取得してから先頭の「次」に進める
    void this.engine.convert(kana).match(
      (candidates) => {
        const current = entry?.candidates[entry.index];
        const merged =
          current === undefined
            ? candidates
            : [current, ...candidates.filter((c) => c !== current)];
        if (merged.length < 2) {
          return;
        }
        this.cache.set(kana, { candidates: merged, index: 1 });
        const chosen = merged[1];
        if (chosen !== undefined) {
          this.onUpdate();
          onChosen(chosen);
        }
      },
      (error) => this.onError(error.message),
    );
  }

  private chosenFor(kana: string): string | null {
    const entry = this.cache.get(kana);
    if (entry === undefined) {
      return null;
    }
    return entry.candidates[entry.index] ?? null;
  }

  private enqueue(kana: string, leftContext: string): void {
    if (this.inflight.has(kana)) {
      return;
    }
    const attempts = this.attempts.get(kana) ?? 0;
    if (attempts >= MAX_ATTEMPTS) {
      // リトライ上限。かなのまま確定させ、無限再投入を防ぐ
      this.cache.set(kana, { candidates: [kana], index: 0 });
      return;
    }
    this.inflight.add(kana);
    this.attempts.set(kana, attempts + 1);
    void this.engine.convert(kana, leftContext === "" ? undefined : leftContext).match(
      (candidates) => {
        this.inflight.delete(kana);
        const best = candidates[0];
        if (best !== undefined) {
          this.cache.set(kana, { candidates, index: 0 });
          this.onConverted(kana, best);
        }
        this.onUpdate();
      },
      (error) => {
        this.inflight.delete(kana);
        this.onError(error.message);
        this.onUpdate();
      },
    );
  }
}
