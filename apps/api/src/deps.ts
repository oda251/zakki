import type { IdentityProvider } from "@zakki/api/auth/providers/types.ts";
import type { ControlDb } from "@zakki/api/db/client.ts";
import type { TursoPlatform } from "@zakki/core/turso/platform.ts";

/**
 * ルートが使う依存の束（apps/web/src/server/deps.ts と同じ流儀）。
 * index.ts（Workers の本番合成点）とテストが注入する。
 * コントロールプレーンは E2E を破らない: DEK・本文・暗号鍵は扱わない。
 */
export interface AppDeps {
  db: ControlDb;
  auth: AuthConfig;
  /**
   * ログインに使える外部 ID プロバイダ（docs/MULTIUSER.md「ログイン（OIDC）」）。
   * ルート（routes/auth.ts）はこの型だけを知り、Google かどうかを知らない。
   * `id` で `/auth/oidc/:provider/*` の provider パラメータと引き合わせる
   */
  providers: readonly IdentityProvider[];
  /** ユーザごと DB のプロビジョニング先（issue #101）。テストは fake サーバを向ける */
  turso: TursoPlatform;
}

/**
 * OIDC ログインの設定（docs/MULTIUSER.md「ログイン（OIDC）」）。値は検証済み env（env.ts）から来る。
 *
 * ここに現れるのは SPA の origin とセッション署名鍵だけで、E2E の鍵材料
 * （DEK・PRF 出力・封筒）は一切含まない。
 */
export interface AuthConfig {
  /** SPA の origin（例 https://zakki.example.com）。CORS の許可元・ログイン後の戻り先 */
  readonly appOrigin: string;
  /** セッション JWT（HS256）の署名鍵 */
  readonly sessionSecret: string;
}
