import { useEffect, useState } from "react";
import { makeTitle } from "@zakki/core/chunk/chunker.ts";
import { api } from "@zakki/web/client/api/client.ts";
import { Composer } from "@zakki/web/client/composer/Composer.tsx";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";

interface ConversionSeed {
  corrections: ReadonlyMap<string, string>;
  cache: ReadonlyMap<string, string>;
}

/**
 * Composer の合成点: 現在のバッファ（親チャンク）と変換シード（corrections/cache）が
 * 揃ったら Composer を組み立てる。バッファ切替は key で丸ごと作り直す（store も張り直し）。
 */
export function ComposerPane() {
  const current = useBufferStore((s) => s.current);
  const initialRaw = useBufferStore((s) => s.initialRaw);
  const initialChunkIds = useBufferStore((s) => s.initialChunkIds);
  const error = useBufferStore((s) => s.error);
  const [seed, setSeed] = useState<ConversionSeed | null>(null);

  useEffect(() => {
    api
      .conversionState()
      .then((state) =>
        setSeed({
          corrections: new Map(Object.entries(state.corrections)),
          cache: new Map(Object.entries(state.cache)),
        }),
      )
      .catch(() => setSeed({ corrections: new Map(), cache: new Map() }));
  }, []);

  if (error !== null) {
    return <div className="empty-note">バッファ読み込みエラー: {error}</div>;
  }
  if (current === null || initialRaw === null || seed === null) {
    return <div className="empty-note">読み込み中…</div>;
  }
  return (
    <div>
      <div className="composer__session">{current.date ?? makeTitle(current.content)}</div>
      <Composer
        key={current.id}
        parent={current}
        initialRaw={initialRaw}
        initialChunkIds={initialChunkIds}
        corrections={seed.corrections}
        conversionCache={seed.cache}
      />
    </div>
  );
}
