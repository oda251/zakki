/**
 * ファイル暗号（FEK）のパスワード管理（issue #157 §5）。
 *
 * パスワードはユーザごとに一律で、このモジュールがクライアント側で:
 * 1. FEK を生成し、パスワード由来の KEK で wrap して封筒（id=1）をサーバへ保存
 * 2. 保存済み封筒を取得して unwrap（= 添付ファイルの暗号化・復号に使う FEK を復元）
 *
 * サーバは封筒を保存・配布するだけで、パスワード・FEK・復号は一切触らない
 * （#28 の不変条件 / depcruise `web-server-no-decrypt-capability`）。
 *
 * 事前に {@link import("@zakki/core/crypto/sodium.ts").ready} 完了が前提（呼び出し側の責務）。
 */
import { generateFek, rewrapFek, unwrapFek, wrapFek } from "@zakki/core/crypto/file-key.ts";
import { defaultKdfParams, generateSalt } from "@zakki/core/crypto/kdf.ts";
import { fromBase64, toBase64 } from "@zakki/core/crypto/wire.ts";
import type { FetchLike } from "@zakki/web/client/api/client.ts";
import { API_BASE } from "@zakki/web/shared/api-base.ts";
import type { FileEnvelope } from "@zakki/web/shared/api-schemas.ts";

/** Argon2id パラメータの上書き（テストは最小値で高速化する）。省略時は既定（INTERACTIVE） */
export interface FilePasswordParams {
  readonly opsLimit: number;
  readonly memLimit: number;
}

const envelopePath = `${API_BASE}/crypto/file-envelope`;

async function getEnvelope(fetchFn: FetchLike): Promise<FileEnvelope | null> {
  const res = await fetchFn(envelopePath);
  if (res.status === 401) throw new Error("認証が必要です");
  if (!res.ok) throw new Error("ファイル暗号の封筒の取得に失敗しました");
  // HTTP JSON は untyped。api-schemas の FileEnvelopeSchema と 1:1 の読み替え境界
  const body: { envelope: FileEnvelope | null } = await res.json();
  return body.envelope;
}

async function putEnvelope(fetchFn: FetchLike, envelope: FileEnvelope): Promise<void> {
  const res = await fetchFn(envelopePath, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (res.status === 401) throw new Error("認証が必要です");
  if (!res.ok) throw new Error("ファイル暗号の封筒の保存に失敗しました");
}

/** パスワードによるファイル暗号の封筒が設定済みか（無ければ初回設定の導線を表示する） */
export async function hasFilePassword(opts: { fetchFn?: FetchLike }): Promise<boolean> {
  const fetchFn = opts.fetchFn ?? fetch;
  return (await getEnvelope(fetchFn)) !== null;
}

/**
 * ファイル暗号のパスワードを設定し、新規生成した FEK を返す。
 * 封筒はサーバ（id=1）へ保存される。2 回目は上書き（すでにファイルがあって
 * パスワードを再設定する場合は setFilePassword ではなく changeFilePassword を使う）。
 */
export async function setFilePassword(opts: {
  password: string;
  fetchFn?: FetchLike;
  params?: FilePasswordParams;
}): Promise<Uint8Array> {
  const fetchFn = opts.fetchFn ?? fetch;
  const params = opts.params ?? defaultKdfParams();
  const fek = generateFek();
  const salt = generateSalt();
  await putEnvelope(fetchFn, {
    wrappedFek: toBase64(wrapFek(fek, opts.password, salt, params)),
    kdfSalt: toBase64(salt),
    kdfOps: params.opsLimit,
    kdfMem: params.memLimit,
  });
  return fek;
}

/**
 * 保存済み封筒をパスワードで開き、FEK を取り出す。未設定・パスワード違いは null
 * （例外を UI へ漏らさない。UI は「暗号化されたファイルが開けない」の案内だけに使う）。
 */
export async function unlockFek(opts: {
  password: string;
  fetchFn?: FetchLike;
}): Promise<Uint8Array | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const envelope = await getEnvelope(fetchFn);
  if (envelope === null) return null;
  try {
    return unwrapFek(
      fromBase64(envelope.wrappedFek),
      opts.password,
      fromBase64(envelope.kdfSalt),
      { opsLimit: envelope.kdfOps, memLimit: envelope.kdfMem },
    );
  } catch {
    return null;
  }
}

/**
 * パスワードを変更する。FEK 自体は再生成しない（既存ファイル part の暗号文が
 * 読めなくなるため。同じ FEK を新しい KEK で wrap し直した封筒へ差し替えるだけ）。
 * 旧パスワードが違えば失敗して throw し、封筒は差し替わらない。
 */
export async function changeFilePassword(opts: {
  oldPassword: string;
  newPassword: string;
  fetchFn?: FetchLike;
  params?: FilePasswordParams;
}): Promise<void> {
  const fetchFn = opts.fetchFn ?? fetch;
  const params = opts.params ?? defaultKdfParams();
  const envelope = await getEnvelope(fetchFn);
  if (envelope === null) {
    throw new Error("ファイル暗号の封筒が設定されていません");
  }
  const oldSalt = fromBase64(envelope.kdfSalt);
  const newSalt = generateSalt();
  const rewraped = rewrapFek(
    fromBase64(envelope.wrappedFek),
    opts.oldPassword,
    oldSalt,
    { opsLimit: envelope.kdfOps, memLimit: envelope.kdfMem },
    opts.newPassword,
    newSalt,
    params,
  );
  await putEnvelope(fetchFn, {
    wrappedFek: toBase64(rewraped),
    kdfSalt: toBase64(newSalt),
    kdfOps: params.opsLimit,
    kdfMem: params.memLimit,
  });
}