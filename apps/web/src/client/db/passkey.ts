/**
 * WebAuthn passkey（PRF 拡張）によるクライアント側アンロック / 登録（issue #104, #120）。
 *
 * **PRF 出力はクレデンシャル（鍵ペア）ごとに異なる**ので、封筒もクレデンシャルごとに
 * 1 本ある（issue #120）。この層は常に「どのクレデンシャルの PRF か」を
 * {@link PrfEvaluation} として持ち回り、アンロックでは全封筒の credentialId を
 * allowCredentials に載せて認証器（＝ユーザ）に選ばせる。
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
 * アカウントと紐付けるのは #105）。同じハンドルで再登録すると **同じ認証器の中では**
 * 資格情報が置き換わるため、1 台の端末にパスキーが無制限に増えることはない。
 *
 * 別の端末（別の認証器）で登録すれば別のクレデンシャル＝別の PRF 出力になるので、
 * 封筒も別に作られる（#120。これが「スマホとノート PC の両方で開ける」の実体）。
 * なお同じ認証器で再登録した場合、置き換わる前のクレデンシャルの封筒は開ける鍵を
 * 失ったまま残る（無害だが掃除は {@link revokePasskeyEnvelope} の責務）。
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
 * PRF 評価の結果。**どのクレデンシャルで評価したか** を必ず伴う（issue #120）。
 *
 * PRF 出力は鍵ペアごとに異なり、封筒もクレデンシャルごとに 1 本ある。出力だけを
 * 持ち回ると「どの封筒に対応する出力か」が失われ、総当たり復号でしか開けなくなる。
 */
export interface PrfEvaluation {
  /** base64url の WebAuthn credential id（封筒の credentialId と同じ表記） */
  readonly credentialId: string;
  /** PRF 出力（32 バイト）。メモリのみで扱い、wire にも永続ストレージにも出さない */
  readonly prfOutput: Uint8Array;
}

/**
 * `credentials.get` の戻り値から PRF 評価結果（credential id + 32 バイト出力）を取り出す。
 *
 * 取り出しだけを切り出してあるのは、PRF 評価が **必ずしも専用の get** とは限らないため:
 * コントロールプレーンへのログイン（issue #105）は同じ 1 回の get で assertion と
 * PRF 出力の両方を受け取り、この関数で後者だけを読む。
 *
 * @throws {PasskeyError} キャンセル・PRF 未対応・出力長が不正な場合
 */
export function readPrfEvaluation(credential: Credential | null): PrfEvaluation {
  assertPrfCapable(credential);
  const first = credential.getClientExtensionResults().prf?.results?.first;
  if (first === undefined) {
    throw new PasskeyError("認証器から PRF 出力が得られませんでした（PRF 未対応）");
  }
  const output = toBytes(first);
  if (output.length !== PRF_OUTPUT_BYTES) {
    throw new PasskeyError(`PRF 出力の長さが不正です（${output.length} バイト）`);
  }
  return { credentialId: credential.id, prfOutput: output };
}

/**
 * 既存のパスキーで PRF を評価し、32 バイトのシークレットを得る。
 *
 * @param credentialIds allowCredentials に載せる資格情報 id（空なら discoverable credential に任せる）。
 *   複数渡すと **認証器（＝ユーザ）がどれを使うかを選ぶ** ので、返り値の credentialId で
 *   開ける封筒を引き当てる（issue #120）
 * @throws {PasskeyError} キャンセル・PRF 未対応・出力長が不正な場合
 */
export async function evaluatePrf(
  api: CredentialsApi,
  credentialIds: readonly string[] = [],
): Promise<PrfEvaluation> {
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
  return readPrfEvaluation(credential);
}

/** 封筒一覧から passkey 封筒だけを取り出す（複数ありうる, issue #120） */
function passkeyEnvelopes(envelopes: readonly CryptoEnvelope[]): PasskeyCryptoEnvelope[] {
  return envelopes.filter((e): e is PasskeyCryptoEnvelope => e.kind === "passkey");
}

/**
 * **評価済みの** PRF で passkey 封筒を開く（issue #105）。
 *
 * コントロールプレーンへのログインは assertion と PRF 出力を 1 回の `get()` で得るので、
 * その結果をここへ渡せば **生体認証をもう一度求めずに**アンロックできる。開けるのは
 * 「ログインに使ったクレデンシャルの封筒」だけ（PRF 出力はクレデンシャル固有なので、
 * 他のパスキーの封筒はそもそも開かない, #120）。該当封筒が無い・評価結果が無い・
 * 開けない場合は null で、呼び出し側は従来の経路へ落ちる。
 */
export function unlockWithEvaluatedPrf(
  envelopes: readonly CryptoEnvelope[],
  prf: PrfEvaluation | null | undefined,
): Uint8Array | null {
  if (prf === null || prf === undefined) return null;
  const envelope = passkeyEnvelopes(envelopes).find((e) => e.credentialId === prf.credentialId);
  if (envelope === undefined) return null;
  try {
    return openPasskeyEnvelope(envelope, prf.prfOutput);
  } catch {
    // 封筒の改竄・別 rpId での再登録等で AEAD 認証に失敗。秘密は出さない
    console.warn("zakki-passkey: ログイン時の PRF 出力では封筒を開けませんでした");
    return null;
  }
}

/**
 * passkey 封筒があれば PRF 評価 → unwrap して DEK を返す（無言アンロック）。
 *
 * 封筒が複数ある（パスキーを複数登録した, issue #120）場合は **全部の credentialId を
 * allowCredentials に載せて** 認証器に選ばせ、返ってきた credential id に対応する封筒を
 * 開ける。どれか 1 本のパスキーが手元にあれば開くので、機種変更・デバイス追加が効く。
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
  const candidates = passkeyEnvelopes(envelopes);
  if (candidates.length === 0) return null;
  try {
    const prf = await evaluatePrf(
      api,
      candidates.map((e) => e.credentialId),
    );
    const envelope = candidates.find((e) => e.credentialId === prf.credentialId);
    if (envelope === undefined) {
      // allowCredentials を無視した認証器（封筒の無いパスキーで応答）
      console.warn("zakki-passkey: 応答したパスキーに対応する封筒がありません");
      return null;
    }
    return openPasskeyEnvelope(envelope, prf.prfOutput);
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
  await postPasskeyEnvelope(dek, await evaluatePrf(api, [credentialId]), options);
}

/** 評価済みの PRF で DEK を wrap して保存する（登録・自己修復の共通部）。 */
async function postPasskeyEnvelope(
  dek: Uint8Array,
  prf: PrfEvaluation,
  options: { fetchFn?: FetchLike },
): Promise<void> {
  const wrappedDek = wrapDek(dek, deriveKekFromPrf(prf.prfOutput));
  await request<{ ok: boolean }>(
    "/crypto/envelopes/passkey",
    {
      method: "POST",
      body: JSON.stringify({
        wrappedDek: sodium.to_base64(wrappedDek, sodium.base64_variants.ORIGINAL),
        credentialId: prf.credentialId,
      }),
    },
    options.fetchFn,
  );
}

/**
 * **自己修復**（issue #120）: いま使っているクレデンシャルの封筒が無ければ、その場で作る。
 *
 * ログインの `get()` で PRF を評価済み（#105）なのに、その credentialId の封筒が無い
 * ＝「パスキーは使えるが記録は読めない」状態。原因は登録の 2 段目（封筒 POST）だけが
 * 失敗した取りこぼしや、#115 で追加したパスキーに封筒を作り損ねた場合。DEK が他の手段
 * （パスフレーズ等）で得られた直後なら、**生体認証を追加で求めずに** 封筒を埋められる。
 *
 * 起動を止めないため、保存の失敗は警告に畳んで false を返す（次回また試みる）。
 *
 * @returns 封筒を新しく作ったら true
 */
export async function healPasskeyEnvelope(
  dek: Uint8Array,
  prf: PrfEvaluation | null | undefined,
  envelopes: readonly CryptoEnvelope[],
  options: { fetchFn?: FetchLike } = {},
): Promise<boolean> {
  if (prf === null || prf === undefined) return false;
  if (passkeyEnvelopes(envelopes).some((e) => e.credentialId === prf.credentialId)) return false;
  try {
    await postPasskeyEnvelope(dek, prf, options);
    return true;
  } catch (err: unknown) {
    console.warn(
      `zakki-passkey: 封筒の自己修復に失敗しました（次回再試行）: ${err instanceof Error ? err.name : "unknown"}`,
    );
    return false;
  }
}

/**
 * passkey 封筒を 1 本消す（失効の 2 段階目, issue #120）。
 *
 * パスキーの失効は **2 つの DB に跨る**: クレデンシャル（公開鍵）はコントロールプレーン
 * DB（`DELETE /auth/credentials/:id`, #115）、封筒はユーザ自身のジャーナル DB。サーバは
 * 互いの DB を触らないので、両方消すのは **クライアントの責務**。順序はクレデンシャル →
 * 封筒（先に封筒だけ消えるとアンロック手段を失うため）。片方だけ成功しても致命的では
 * ないが、封筒が残るとバックアップに無意味な行が残るので掃除する。
 */
export async function revokePasskeyEnvelope(
  credentialId: string,
  options: { fetchFn?: FetchLike } = {},
): Promise<void> {
  await request<{ ok: boolean; deleted: boolean }>(
    `/crypto/envelopes/passkey/${encodeURIComponent(credentialId)}`,
    { method: "DELETE" },
    options.fetchFn,
  );
}
