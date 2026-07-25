import type { ControlDb } from "@zakki/api/db/client.ts";

/**
 * ルートが使う依存の束（apps/web/src/server/deps.ts と同じ流儀）。
 * index.ts（Workers の本番合成点）とテストが注入する。
 * コントロールプレーンは E2E を破らない: DEK・本文・暗号鍵は扱わない。
 */
export interface AppDeps {
  db: ControlDb;
  auth: AuthConfig;
}

/**
 * パスキー認証の設定（issue #100）。値は検証済み env（env.ts）から来る。
 *
 * ここに現れるのは RP の同一性とセッション署名鍵だけで、E2E の鍵材料
 * （DEK・PRF 出力・封筒）は一切含まない。PRF は registration options で
 * extension を有効化するのみ、評価結果はクライアントに閉じる（#103 / #104）。
 */
export interface AuthConfig {
  /** WebAuthn Relying Party ID（例 zakki.example.com） */
  readonly rpId: string;
  /** 許可する origin（例 https://zakki.example.com）。完全一致で検証する */
  readonly rpOrigin: string;
  /** セッション JWT（HS256）の署名鍵 */
  readonly sessionSecret: string;
}
