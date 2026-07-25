/**
 * テスト専用の fake WebAuthn 認証器（issue #104）。
 *
 * navigator.credentials はローカルで再現できないため、`client/db/passkey.ts` の
 * 注入境界（{@link CredentialsApi}）に **プロトコルレベル**（PublicKeyCredential 形状を
 * 返すオブジェクト）で差し込む。認証器の中身（credential ごとの PRF シード）は
 * このモジュールが保持し、`prf.results.first` を salt から決定的に導出して返す
 * ＝ 実機と同じく「同じ salt なら常に同じ 32 バイト」が得られる。
 *
 * 本番コード（passkey.ts）はこの fake を知らない（テスト専用分岐を持たない）。
 */
import { createHash, randomBytes } from "node:crypto";
import type { CredentialsApi } from "@zakki/web/client/db/passkey.ts";

function toBytes(src: BufferSource): Uint8Array {
  return ArrayBuffer.isView(src)
    ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
    : new Uint8Array(src);
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** credential ごとの秘密シード + salt から 32 バイトを決定的に導出（実機 PRF の代役） */
function prfOutput(seed: Uint8Array, salt: Uint8Array): Uint8Array<ArrayBuffer> {
  const digest = createHash("sha256").update(Buffer.from(seed)).update(Buffer.from(salt)).digest();
  return Uint8Array.from(digest);
}

/** PublicKeyCredential のうち passkey.ts が読む面だけを持つ最小の形 */
interface FakeCredential extends Credential {
  getClientExtensionResults: () => AuthenticationExtensionsClientOutputs;
}

function credential(id: string, extensions: AuthenticationExtensionsClientOutputs): FakeCredential {
  return { id, type: "public-key", getClientExtensionResults: () => extensions };
}

export interface FakeAuthenticatorOptions {
  /** PRF 拡張に未対応の認証器/ブラウザを再現する（create は enabled を返さない） */
  prfSupported?: boolean;
  /** get のたびに投げる（ユーザキャンセル・認証器エラーの再現） */
  failGet?: boolean;
}

export interface FakeAuthenticator extends CredentialsApi {
  /** 登録済み credentialId 一覧（テストのアサーション用） */
  credentialIds: () => string[];
  /** 別の認証器に差し替えられた状況（PRF 出力が変わる）を再現する */
  rotateSeed: () => void;
  /** 登録後に PRF 対応が失われた状況（ブラウザ更新・別ブラウザ）を再現する */
  setPrfSupported: (supported: boolean) => void;
}

/** PublicKeyCredential 形状を返す fake を組み立てる */
export function fakeAuthenticator(options: FakeAuthenticatorOptions = {}): FakeAuthenticator {
  let prfSupported = options.prfSupported ?? true;
  const seeds = new Map<string, Uint8Array>();

  return {
    credentialIds: () => [...seeds.keys()],
    rotateSeed: () => {
      for (const id of seeds.keys()) seeds.set(id, new Uint8Array(randomBytes(32)));
    },
    setPrfSupported: (supported) => {
      prfSupported = supported;
    },

    create: (credentialOptions) => {
      const publicKey = credentialOptions.publicKey;
      if (publicKey === undefined) throw new Error("publicKey が無い");
      const id = base64url(new Uint8Array(randomBytes(16)));
      seeds.set(id, new Uint8Array(randomBytes(32)));
      const enabled = prfSupported && publicKey.extensions?.prf !== undefined;
      // PRF は create では有効化のみを返す（実機と同じ。評価は get）
      return Promise.resolve(credential(id, enabled ? { prf: { enabled: true } } : {}));
    },

    get: (credentialOptions) => {
      if (options.failGet === true) return Promise.reject(new Error("user cancelled"));
      const publicKey = credentialOptions.publicKey;
      if (publicKey === undefined) throw new Error("publicKey が無い");
      const allowed = (publicKey.allowCredentials ?? []).map((c) => base64url(toBytes(c.id)));
      const id = allowed.find((candidate) => seeds.has(candidate)) ?? [...seeds.keys()][0];
      const seed = id === undefined ? undefined : seeds.get(id);
      if (id === undefined || seed === undefined) {
        return Promise.reject(new Error("該当するパスキーがありません"));
      }
      const salt = publicKey.extensions?.prf?.eval?.first;
      if (!prfSupported || salt === undefined) return Promise.resolve(credential(id, {}));
      return Promise.resolve(
        credential(id, { prf: { results: { first: prfOutput(seed, toBytes(salt)) } } }),
      );
    },
  };
}
