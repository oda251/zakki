import { ConversionPipeline } from "./pipeline.ts";
import type { PipelineOptions } from "./pipeline.ts";
import type { KanaKanjiEngine } from "./engine.ts";
import { stripPasteMarkers } from "./paste.ts";
import { segmentKana } from "./segment.ts";
import { convertRomaji } from "@zakki/core/romaji/convert.ts";

export interface ConversionSessionOptions extends PipelineOptions {
  /** 非同期変換の確定通知（再描画・再保存の駆動） */
  onUpdate: () => void;
  onError: (message: string) => void;
  /** rotate（候補ローテーション）の選択通知（呼び出し側が corrections へ学習） */
  onChosen: (kana: string, chosen: string) => void;
}

export interface ConversionSession {
  /** raw（凍結リテラル込み）を確定テキストへ変換する（保存・確定・凍結で共有） */
  convertRaw: (input: string, flush?: boolean) => { text: string; converting: number };
  /** ライブ末尾の表示用変換（変換済みテキスト + 打鍵途中の pending ローマ字） */
  convertLive: (liveRaw: string) => { text: string; pending: string; converting: number };
  /** ローマ字 1 文を確定テキストへ変換し、変換が settled かを返す（freezeLiveTail 用） */
  convertSettled: (sentenceRomaji: string) => { text: string; settled: boolean };
  /** 直前の変換単位の候補ローテーション（1 キー手動修正）。選択は onChosen へ */
  rotateLastSegment: (raw: string) => void;
}

/**
 * 変換パイプラインの合成（機能ロジック・platform 非依存, docs/COMPOSER.md 軸2）。
 * TUI（App.tsx）と Composer.Web が同一の合成を共有し、エンジンと副作用
 * （永続化・エラー表示）だけを注入で差し替える。
 */
export function createConversionSession(
  engine: KanaKanjiEngine,
  options: ConversionSessionOptions,
): ConversionSession {
  const { onUpdate, onError, onChosen, ...pipelineOptions } = options;
  const pipeline = new ConversionPipeline(engine, onUpdate, onError, pipelineOptions);

  const convertRaw = (input: string, flush = false) => {
    const applied = pipeline.apply(convertRomaji(input, { flush }).converted);
    return { text: stripPasteMarkers(applied.text), converting: applied.converting };
  };

  return {
    convertRaw,
    convertLive: (liveRaw) => {
      const { converted, pending } = convertRomaji(liveRaw);
      const applied = pipeline.apply(converted);
      // ライブ末尾に凍結リテラル（マーカー）は含まれないため strip は実質 no-op（防御的）
      return { text: stripPasteMarkers(applied.text), pending, converting: applied.converting };
    },
    convertSettled: (sentenceRomaji) => {
      const { text, converting } = convertRaw(sentenceRomaji, true);
      return { text, settled: converting === 0 };
    },
    rotateLastSegment: (raw) => {
      const kana = convertRomaji(raw).converted;
      const target = segmentKana(kana)
        .filter((s) => s.complete && !s.separator)
        .at(-1);
      if (target === undefined) return;
      pipeline.rotate(target.text, (chosen) => onChosen(target.text, chosen));
    },
  };
}
