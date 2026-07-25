/**
 * テスト専用のソフトウェア WebAuthn 認証器（issue #100）。
 *
 * 実機の認証器はローカルで再現できない依存なので、~/.references/policy/testing.md
 * に従い**プロトコルレベル**で用意する: WebCrypto の P-256（ES256）鍵で本物の
 * attestation（fmt: none）/ assertion を組み立て、実際に verify エンドポイントへ
 * POST する。@simplewebauthn のメソッドは一切 mock しない（mock すると
 * 「ライブラリの呼び方が正しいか」しか見られず、署名検証の実体が抜ける）。
 *
 * プロダクションコードからは import しない（apps/web/server/replication/test-fixtures.ts
 * と同じ分離）。CBOR / COSE / DER はここで必要な最小形だけを手で書く。
 */

// --- バイト列ユーティリティ ------------------------------------------------

/**
 * 素の `Uint8Array` は `Uint8Array<ArrayBufferLike>`（SharedArrayBuffer 由来を含む）で、
 * WebCrypto の `BufferSource` には渡せない。ここで作るのは常に通常の ArrayBuffer 上の
 * ビューなので、その前提を型に固定する。
 */
type Bytes = Uint8Array<ArrayBuffer>;

function concat(parts: readonly Bytes[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** base64url（パディング無し）。認証器 → RP の wire 表現 */
export function toBase64Url(bytes: Bytes): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function utf8(text: string): Bytes {
  return new TextEncoder().encode(text);
}

/** base64url → バイト列（JWK の x / y をデコードする） */
function fromBase64Url(text: string): Bytes {
  return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (ch) =>
    ch.charCodeAt(0),
  );
}

async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function uint16(n: number): Bytes {
  return Uint8Array.of((n >> 8) & 0xff, n & 0xff);
}

function uint32(n: number): Bytes {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

// --- 最小 CBOR エンコーダ --------------------------------------------------

/** CBOR マップ。キー順は CTAP2 canonical（短い順・バイト順）で呼び出し側が並べる */
interface CborMap {
  readonly map: readonly (readonly [number | string, CborValue])[];
}

type CborValue = number | string | Bytes | CborMap;

/** major type + 引数（長さ / 値）のヘッダ */
function head(major: number, n: number): Bytes {
  const tag = major << 5;
  if (n < 24) return Uint8Array.of(tag | n);
  if (n < 0x100) return Uint8Array.of(tag | 24, n);
  if (n < 0x10000) return concat([Uint8Array.of(tag | 25), uint16(n)]);
  return concat([Uint8Array.of(tag | 26), uint32(n)]);
}

function encodeCbor(value: CborValue): Bytes {
  if (typeof value === "number") {
    // 負の整数は major type 1 で -1-n を格納する（COSE の alg: -7 等）
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = utf8(value);
    return concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return concat([head(2, value.length), value]);
  }
  return concat([
    head(5, value.map.length),
    ...value.map.map(([k, v]) => concat([encodeCbor(k), encodeCbor(v)])),
  ]);
}

// --- DER（ECDSA 署名） -----------------------------------------------------

/** DER INTEGER（先頭ゼロを詰め、最上位ビットが立つなら 0x00 を足す） */
function derInteger(bytes: Bytes): Bytes {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  let value = bytes.slice(start);
  if (((value[0] ?? 0) & 0x80) !== 0) value = concat([Uint8Array.of(0), value]);
  return concat([Uint8Array.of(0x02, value.length), value]);
}

/**
 * WebCrypto の ECDSA 署名（生の r||s）を WebAuthn が使う DER SEQUENCE へ包む。
 * P-256 では本体が必ず 128 バイト未満なので長さは 1 バイトで足りる。
 */
function toDerSignature(raw: Bytes): Bytes {
  const body = concat([derInteger(raw.slice(0, 32)), derInteger(raw.slice(32, 64))]);
  return concat([Uint8Array.of(0x30, body.length), body]);
}

// --- authenticator data のフラグ -------------------------------------------

const FLAG_UP = 0x01; // User Present
const FLAG_UV = 0x04; // User Verified
const FLAG_BE = 0x08; // Backup Eligible（マルチデバイスなパスキー）
const FLAG_BS = 0x10; // Backup State（BE 無しで立てると不正なフラグ組合せになる）
const FLAG_AT = 0x40; // Attested credential data あり（登録時のみ）

/** 検証を通す既定のフラグ: UV 必須 + backup 可能なパスキー */
const PASSKEY_FLAGS = FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS;

// --- 認証器 ----------------------------------------------------------------

/** 認証器が返す登録レスポンス（RegistrationResponseJSON と同じ形） */
export interface AttestationPayload {
  id: string;
  rawId: string;
  response: { clientDataJSON: string; attestationObject: string; transports: string[] };
  type: "public-key";
  clientExtensionResults: Record<string, unknown>;
}

/** 認証器が返す認証レスポンス（AuthenticationResponseJSON と同じ形） */
export interface AssertionPayload {
  id: string;
  rawId: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  type: "public-key";
  clientExtensionResults: Record<string, unknown>;
}

export interface AttestOptions {
  challenge: string;
  origin: string;
  /** 既定は "webauthn.create"。type 不一致の異常系で差し替える */
  type?: string;
}

export interface AssertOptions {
  challenge: string;
  origin: string;
  /** 認証器が報告する signCount。巻き戻し（クローン検知）の検証で下げる */
  counter: number;
  /** UV フラグを落として UV 必須の検証を落とす異常系用 */
  userVerified?: boolean;
}

export interface SoftAuthenticator {
  /** base64url のクレデンシャル ID */
  readonly credentialId: string;
  attest(options: AttestOptions): Promise<AttestationPayload>;
  assert(options: AssertOptions): Promise<AssertionPayload>;
}

function clientDataJson(type: string, challenge: string, origin: string): Bytes {
  // 実際のブラウザと同じキー順（type, challenge, origin, crossOrigin）で組む。
  // 検証側はこのバイト列そのものをハッシュするので、文字列として固定する
  return utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

/**
 * P-256 のソフトウェア認証器を作る。`rpId` は authData の rpIdHash に焼かれるので、
 * RP ID 不一致の異常系はここに違う値を渡して作る。
 */
export async function createSoftAuthenticator(rpId: string): Promise<SoftAuthenticator> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const x = fromBase64Url(jwk.x ?? "");
  const y = fromBase64Url(jwk.y ?? "");

  // COSE_Key（EC2 / P-256 / ES256）。キー順は 1, 3, -1, -2, -3 が canonical
  const cosePublicKey = encodeCbor({
    map: [
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, x],
      [-3, y],
    ],
  });

  const rpIdHash = await sha256(utf8(rpId));
  const aaguid = new Uint8Array(16); // none attestation なので全ゼロ
  const rawCredentialId = crypto.getRandomValues(new Uint8Array(32));
  const credentialId = toBase64Url(rawCredentialId);

  const sign = async (data: Bytes): Promise<Bytes> => {
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, data),
    );
    return toDerSignature(raw);
  };

  return {
    credentialId,

    async attest({ challenge, origin, type = "webauthn.create" }) {
      const clientData = clientDataJson(type, challenge, origin);
      const attestedCredentialData = concat([
        aaguid,
        uint16(rawCredentialId.length),
        rawCredentialId,
        cosePublicKey,
      ]);
      const authData = concat([
        rpIdHash,
        Uint8Array.of(PASSKEY_FLAGS | FLAG_AT),
        uint32(0),
        attestedCredentialData,
      ]);
      // fmt: none は attStmt が空マップ。キー順は CTAP2 canonical（fmt < attStmt < authData）
      const attestationObject = encodeCbor({
        map: [
          ["fmt", "none"],
          ["attStmt", { map: [] }],
          ["authData", authData],
        ],
      });
      return {
        id: credentialId,
        rawId: credentialId,
        response: {
          clientDataJSON: toBase64Url(clientData),
          attestationObject: toBase64Url(attestationObject),
          transports: ["internal"],
        },
        type: "public-key",
        clientExtensionResults: {},
      };
    },

    async assert({ challenge, origin, counter, userVerified = true }) {
      const clientData = clientDataJson("webauthn.get", challenge, origin);
      const flags = userVerified ? PASSKEY_FLAGS : PASSKEY_FLAGS & ~FLAG_UV;
      const authData = concat([rpIdHash, Uint8Array.of(flags), uint32(counter)]);
      // WebAuthn の署名対象は authenticatorData || SHA-256(clientDataJSON)
      const signature = await sign(concat([authData, await sha256(clientData)]));
      return {
        id: credentialId,
        rawId: credentialId,
        response: {
          clientDataJSON: toBase64Url(clientData),
          authenticatorData: toBase64Url(authData),
          signature: toBase64Url(signature),
        },
        type: "public-key",
        clientExtensionResults: {},
      };
    },
  };
}
