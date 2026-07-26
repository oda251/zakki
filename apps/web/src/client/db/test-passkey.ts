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
  /**
   * get の成否を切り替える。Safari のユーザジェスチャ要求（非ジェスチャ文脈の
   * 自動試行は NotAllowedError、クリック起点なら成功）を再現するために使う。
   */
  setFailGet: (fail: boolean) => void;
  /**
   * 複数パスキーがあるとき、ユーザがどれを選ぶかを固定する（issue #120）。
   * 実機では allowCredentials に複数載っていると認証器/OS の UI がユーザに選ばせる。
   * null に戻すと「allowCredentials の先頭にある手持ちのパスキー」を選ぶ既定に戻る。
   */
  setSelectedCredential: (credentialId: string | null) => void;
  /** そのクレデンシャルを認証器から取り除く（端末紛失・パスキー削除の再現） */
  forgetCredential: (credentialId: string) => void;
}

/** PublicKeyCredential 形状を返す fake を組み立てる */
export function fakeAuthenticator(options: FakeAuthenticatorOptions = {}): FakeAuthenticator {
  let prfSupported = options.prfSupported ?? true;
  let failGet = options.failGet ?? false;
  let selected: string | null = null;
  const seeds = new Map<string, Uint8Array>();

  return {
    credentialIds: () => [...seeds.keys()],
    rotateSeed: () => {
      for (const id of seeds.keys()) seeds.set(id, new Uint8Array(randomBytes(32)));
    },
    setPrfSupported: (supported) => {
      prfSupported = supported;
    },
    setFailGet: (fail) => {
      failGet = fail;
    },
    setSelectedCredential: (credentialId) => {
      selected = credentialId;
    },
    forgetCredential: (credentialId) => {
      seeds.delete(credentialId);
      if (selected === credentialId) selected = null;
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
      // 実機の NotAllowedError（キャンセル・ジェスチャ無し）に対応する失敗
      if (failGet) return Promise.reject(new Error("NotAllowedError: user gesture required"));
      const publicKey = credentialOptions.publicKey;
      if (publicKey === undefined) throw new Error("publicKey が無い");
      const allowed = (publicKey.allowCredentials ?? []).map((c) => base64url(toBytes(c.id)));
      // 実機の挙動: allowCredentials に載っていて手元にあるパスキーの中から
      // ユーザが 1 つ選ぶ（複数パスキー, #120）。テストは setSelectedCredential で固定する。
      const usable = allowed.filter((candidate) => seeds.has(candidate));
      const id =
        allowed.length === 0
          ? // allowCredentials 無し = discoverable credential に任せる
            [...seeds.keys()][0]
          : selected !== null && usable.includes(selected)
            ? selected
            : usable[0];
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
