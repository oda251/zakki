/**
 * WebAuthn passkey（PRF 拡張）によるクライアント側アンロック / 登録（issue #104）。
 *
 * 認証器から得た PRF 出力（32 バイト）→ KEK（`deriveKekFromPrf`）→ 封筒の unwrap を
 * **すべてクライアントで** 行う。サーバへ流れるのは wrap 済み封筒と credentialId だけで、
 * PRF 出力・DEK は wire にも永続ストレージ（localStorage / sessionStorage / IndexedDB）にも
 * 出さない（unlock.ts と同じメモリのみ原則, #28 / #103）。
 *
 * navigator.credentials はテスト環境で再現できないため、この層は
 * {@link CredentialsApi}（`navigator.credentials` の必要最小部分）を **注入可能** にし、
 * テストは PublicKeyCredential 形状を返す fake を差し込む。プロダクション経路には
 * テスト専用の分岐を持たせない（既定実装は {@link browserCredentials} だけ）。
 *
 * 事前に {@link import("@zakki/core/crypto/sodium.ts").ready} 完了が前提（呼び出し側の責務）。
 */
import { wrapDek } from "@zakki/core/crypto/dek.ts";
import { deriveKekFromPrf, PRF_OUTPUT_BYTES } from "@zakki/core/crypto/kdf.ts";
import { sodium } from "@zakki/core/crypto/sodium.ts";
import type { FetchLike } from "@zakki/web/client/api/client.ts";
import { request } from "@zakki/web/client/api/client.ts";
import { openPasskeyEnvelope } from "@zakki/web/client/db/unlock.ts";
import type { CryptoEnvelope, PasskeyCryptoEnvelope } from "@zakki/web/shared/api-schemas.ts";

/**
 * PRF 評価に渡す固定 salt（32 バイト）。**秘密ではない**（アプリ定数として公開されてよい）:
 * シークレット性は認証器内の鍵に由来し、salt は「同じ認証器から用途ごとに別の値を引く」
 * ための domain separation にすぎない（docs/RESEARCH.md §6）。
 * **変更すると既存 passkey 封筒が開けなくなる**ため、変更時は v2 salt を追加して
 * 封筒側にバージョンを持たせること。
 */
export const PRF_SALT: Uint8Array<ArrayBuffer> = new TextEncoder().encode(
  "zakki-passkey-prf-salt-v1/pad-32",
);

/**
 * 単一ユーザ self-host 構成での固定ユーザハンドル（#104 の範囲。コントロールプレーンの
 * アカウントと紐付けるのは #105）。同じハンドルで再登録すると認証器側の資格情報が
 * 置き換わるため、パスキーが無制限に増えない。
 */
const USER_HANDLE = new TextEncoder().encode("zakki-local-user");

/** WebAuthn の challenge 長（バイト）。本 issue の範囲ではサーバ検証を行わない（#105） */
const CHALLENGE_BYTES = 32;

/**
 * `navigator.credentials` の必要最小部分。テストが PublicKeyCredential 形状を返す
 * fake を注入するための境界（プロトコルレベルの偽装）。
 */
export interface CredentialsApi {
  create: (options: CredentialCreationOptions) => Promise<Credential | null>;
  get: (options: CredentialRequestOptions) => Promise<Credential | null>;
}

/** passkey 操作の失敗（未対応・キャンセル・PRF 非提供）。メッセージは UI 表示用で秘密を含まない */
export class PasskeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyError";
  }
}

/**
 * 本番の adapter。WebAuthn 非対応環境（PublicKeyCredential 未定義・非セキュアコンテキスト）
 * では null を返し、呼び出し側はパスフレーズ経路のみになる。
 */
export function browserCredentials(): CredentialsApi | null {
  if (typeof window === "undefined") return null;
  if (typeof window.PublicKeyCredential === "undefined") return null;
  const container = window.navigator.credentials;
  // メソッドを剥がすと this を失うため、束ねた薄いラッパを返す
  return {
    create: (options) => container.create(options),
    get: (options) => container.get(options),
  };
}

/** BufferSource → Uint8Array（コピーせずビューを張る） */
function toBytes(src: BufferSource): Uint8Array {
  return ArrayBuffer.isView(src)
    ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
    : new Uint8Array(src);
}

/** WebAuthn の credential id は base64url（no padding）。封筒の credentialId もこの表記で保存する */
function credentialIdToBytes(credentialId: string): Uint8Array<ArrayBuffer> {
  // BufferSource（WebAuthn の型）は ArrayBuffer 裏付けを要求するためコピーして揃える
  return Uint8Array.from(
    sodium.from_base64(credentialId, sodium.base64_variants.URLSAFE_NO_PADDING),
  );
}

interface PrfCapableCredential {
  getClientExtensionResults: () => AuthenticationExtensionsClientOutputs;
}

/**
 * `Credential` は基底型で PublicKeyCredential の面を持たないため、
 * 受け取った値が PRF 結果を読める形かを構造的に判定する（型アサーションを使わない）。
 * null（ユーザキャンセル）もここで弾く。
 */
function assertPrfCapable(
  credential: Credential | null,
): asserts credential is Credential & PrfCapableCredential {
  if (
    credential === null ||
    !("getClientExtensionResults" in credential) ||
    typeof credential.getClientExtensionResults !== "function"
  ) {
    throw new PasskeyError("パスキーの応答が取得できませんでした（キャンセル・未対応）");
  }
}

/**
 * パスキーを新規作成する（PRF 拡張は **有効化のみ**。評価は {@link evaluatePrf} の get で行う）。
 *
 * `residentKey: "required"` + `userVerification: "required"` で、プラットフォーム認証器
 * （Touch ID / Android・iCloud 等の同期パスキー）による discoverable credential を作る。
 * PRF が有効にならなかった場合は例外にして **登録させない**（開けない封筒を作らないため）。
 *
 * @returns 作成した資格情報の id（base64url。封筒の credentialId として保存する）
 */
export async function createPasskeyCredential(
  api: CredentialsApi,
  options: { rpName?: string; userName?: string } = {},
): Promise<string> {
  const credential = await api.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES)),
      rp: { name: options.rpName ?? "zakki" },
      user: {
        id: USER_HANDLE,
        name: options.userName ?? "zakki",
        displayName: options.userName ?? "zakki",
      },
      // ES256 / RS256（認証器の対応が広い順）。zakki は署名検証をしないが必須項目
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      extensions: { prf: {} },
    },
  });
  assertPrfCapable(credential);
  if (credential.getClientExtensionResults().prf?.enabled !== true) {
    throw new PasskeyError(
      "このブラウザ／認証器は WebAuthn PRF 拡張に未対応のため、パスキーでのアンロックを登録できません",
    );
  }
  return credential.id;
}

/**
 * 既存のパスキーで PRF を評価し、32 バイトのシークレットを得る。
 *
 * @param credentialIds allowCredentials に載せる資格情報 id（空なら discoverable credential に任せる）
 * @throws {PasskeyError} キャンセル・PRF 未対応・出力長が不正な場合
 */
export async function evaluatePrf(
  api: CredentialsApi,
  credentialIds: readonly string[] = [],
): Promise<Uint8Array> {
  const allowCredentials = credentialIds.map((id) => ({
    type: "public-key" as const,
    id: credentialIdToBytes(id),
  }));
  const credential = await api.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES)),
      userVerification: "required",
      ...(allowCredentials.length > 0 ? { allowCredentials } : {}),
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  });
  assertPrfCapable(credential);
  const first = credential.getClientExtensionResults().prf?.results?.first;
  if (first === undefined) {
    throw new PasskeyError("認証器から PRF 出力が得られませんでした（PRF 未対応）");
  }
  const output = toBytes(first);
  if (output.length !== PRF_OUTPUT_BYTES) {
    throw new PasskeyError(`PRF 出力の長さが不正です（${output.length} バイト）`);
  }
  return output;
}

/**
 * passkey 封筒があれば PRF 評価 → unwrap して DEK を返す（無言アンロック）。
 *
 * 封筒が無い / adapter が無い（未対応ブラウザ）/ 評価・復号に失敗した場合は **null** を返し、
 * 呼び出し側はパスフレーズ経路へフォールバックする。秘密（PRF 出力・DEK）はログに出さない。
 *
 * 起動時の自動試行（非ジェスチャ文脈）は WebKit のユーザジェスチャ要求により
 * `NotAllowedError` になりうるため、**クリックハンドラからも再実行できる**ように
 * 副作用を持たない純粋な再試行として設計している（bootstrap の `passkey.unlock`）。
 */
export async function unlockWithPasskey(
  envelopes: readonly CryptoEnvelope[],
  api: CredentialsApi | null,
): Promise<Uint8Array | null> {
  if (api === null) return null;
  const envelope = envelopes.find((e): e is PasskeyCryptoEnvelope => e.kind === "passkey");
  if (envelope === undefined) return null;
  try {
    const prfOutput = await evaluatePrf(api, [envelope.credentialId]);
    return openPasskeyEnvelope(envelope, prfOutput);
  } catch (err: unknown) {
    // キャンセル・未対応・PRF 出力違い（AEAD 認証失敗）。エラー種別のみログしてフォールバック
    console.warn(
      `zakki-passkey: パスキーでのアンロックに失敗（パスフレーズへ）: ${err instanceof Error ? err.name : "unknown"}`,
    );
    return null;
  }
}

/**
 * 作成済みのパスキーで PRF を評価し、DEK を **クライアントで wrap** して
 * `POST /crypto/envelopes/passkey`（#103 の経路）へ保存する。平文 DEK・PRF 出力は送らない。
 *
 * 登録が「作成（{@link createPasskeyCredential}）」と「保存（この関数）」に分かれているのは、
 * WebKit がプラットフォーム認証器の WebAuthn 呼び出しに **ユーザジェスチャ** を要求し、
 * 1 回のクリックで消費した activation では 2 度目（PRF 評価の `get`）が
 * `NotAllowedError` になりうるため（出典: https://webkit.org/blog/11312/meet-face-id-and-touch-id-for-the-web/ ）。
 * 続けて呼べる環境（Chrome/Edge）では 1 クリックで完了し、失敗した場合は
 * UI が credentialId を保持したまま別のクリックからこの関数だけを再実行できる。
 */
export async function savePasskeyEnvelope(
  dek: Uint8Array,
  api: CredentialsApi,
  credentialId: string,
  options: { fetchFn?: FetchLike } = {},
): Promise<void> {
  const prfOutput = await evaluatePrf(api, [credentialId]);
  const wrappedDek = wrapDek(dek, deriveKekFromPrf(prfOutput));
  await request<{ ok: boolean }>(
    "/crypto/envelopes/passkey",
    {
      method: "POST",
      body: JSON.stringify({
        wrappedDek: sodium.to_base64(wrappedDek, sodium.base64_variants.ORIGINAL),
        credentialId,
      }),
    },
    options.fetchFn,
  );
}
