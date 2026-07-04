import { useEffect, useState } from "react";
import { api } from "@zakki/web/client/api/client.ts";
import { Composer } from "@zakki/web/client/composer/Composer.tsx";
import { useSessionStore } from "@zakki/web/client/store/session.ts";

interface ConversionSeed {
  corrections: ReadonlyMap<string, string>;
  cache: ReadonlyMap<string, string>;
}

/**
 * Composer の合成点: 現在セッションと変換シード（corrections/cache）が揃ったら
 * Composer を組み立てる。セッション切替は key で丸ごと作り直す（store も張り直し）。
 */
export function ComposerPane() {
  const current = useSessionStore((s) => s.current);
  const initialRaw = useSessionStore((s) => s.initialRaw);
  const error = useSessionStore((s) => s.error);
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
    return <div className="empty-note">セッション読み込みエラー: {error}</div>;
  }
  if (current === null || initialRaw === null || seed === null) {
    return <div className="empty-note">読み込み中…</div>;
  }
  return (
    <div>
      <div className="composer__session">
        {current.date}
        {current.name !== null && ` / ${current.name}`}
      </div>
      <Composer
        key={current.id}
        sessionId={current.id}
        initialRaw={initialRaw}
        corrections={seed.corrections}
        conversionCache={seed.cache}
      />
    </div>
  );
}
