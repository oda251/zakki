import type { KanaKanjiEngine } from "./engine.ts";
import { segmentKana } from "./segment.ts";

const MAX_ATTEMPTS = 3;

export interface ApplyResult {
  /** 変換済みセグメントを置換した表示テキスト */
  text: string;
  /** 変換待ち（実行中含む）のセグメント数 */
  converting: number;
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
 */
export class ConversionPipeline {
  private readonly cache = new Map<string, string>();
  private readonly inflight = new Set<string>();
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly engine: KanaKanjiEngine,
    private readonly onUpdate: () => void,
    private readonly onError: (message: string) => void = () => {},
  ) {}

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
      const converted = this.cache.get(segment.text);
      if (converted !== undefined) {
        text += converted;
        leftContext = converted;
        continue;
      }
      converting += 1;
      this.enqueue(segment.text, leftContext);
      text += segment.text;
      leftContext = segment.text;
    }
    return { text, converting };
  }

  private enqueue(kana: string, leftContext: string): void {
    if (this.inflight.has(kana)) {
      return;
    }
    if ((this.attempts.get(kana) ?? 0) >= MAX_ATTEMPTS) {
      // リトライ上限。かなのまま確定させ、無限再投入を防ぐ
      this.cache.set(kana, kana);
      return;
    }
    this.inflight.add(kana);
    this.attempts.set(kana, (this.attempts.get(kana) ?? 0) + 1);
    void this.engine.convert(kana, leftContext === "" ? undefined : leftContext).match(
      (converted) => {
        this.inflight.delete(kana);
        this.cache.set(kana, converted);
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
