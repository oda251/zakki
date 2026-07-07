import { beforeAll, describe, expect, test } from "bun:test";
import { ready } from "@zakki/core/crypto/sodium.ts";
import type { FieldCrypto } from "@zakki/web/client/db/crypto.ts";
import { makeFieldCrypto } from "@zakki/web/client/db/crypto.ts";
import type { ChunkDocData, LinkDocData } from "@zakki/web/client/db/modifiers.ts";
import {
  chunkPull,
  chunkPush,
  linkPull,
  linkPush,
  tagPull,
  tagPush,
  userTagPull,
  userTagPush,
} from "@zakki/web/client/db/modifiers.ts";

/**
 * Phase 2（#40）: RxDB replication modifier の暗号境界。sodium は bun/WASM で動く
 * （既存 crypto テストと同じ ready パターン）。
 */
let crypto: FieldCrypto;
beforeAll(async () => {
  const s = await ready();
  crypto = makeFieldCrypto(s.crypto_aead_xchacha20poly1305_ietf_keygen());
});

const chunkDoc = (over: Partial<ChunkDocData> & { id: string }): ChunkDocData => ({
  parentId: "0",
  position: 0,
  content: "今日はコードを書いた",
  date: null,
  polarity: null,
  updatedAt: "2026-07-06T00:00:00.000Z",
  _deleted: false,
  ...over,
});

describe("replication modifiers (Phase 2)", () => {
  test("chunk 往復（date=null）は元の doc を復元する", () => {
    const doc = chunkDoc({ id: "1", content: "秘密の本文", polarity: 0.5 });
    expect(chunkPull(crypto, chunkPush(crypto, doc))).toEqual(doc);
  });

  test("chunk content は wire で暗号化される（base64・復号可）", () => {
    const doc = chunkDoc({ id: "1", content: "秘密の本文" });
    const wire = chunkPush(crypto, doc);
    expect(wire.content).not.toBe("秘密の本文");
    expect(crypto.decString(wire.content, "chunk.content")).toBe("秘密の本文");
  });

  test("日付チャンク（date≠null）は content を暗号化しない", () => {
    const doc = chunkDoc({ id: "d", parentId: null, date: "2026-07-06", content: "2026-07-06" });
    const wire = chunkPush(crypto, doc);
    expect(wire.content).toBe("2026-07-06");
    expect(chunkPull(crypto, wire).content).toBe("2026-07-06");
  });

  test("AAD 束縛: chunk.content の暗号文を別ラベルで復号すると失敗する", () => {
    const wire = chunkPush(crypto, chunkDoc({ id: "1", content: "秘密" }));
    expect(() => crypto.decString(wire.content, "tag.name")).toThrow();
  });

  test("tag 往復＋決定的 fingerprint。wire は updatedAt（checkpoint 用）を運ぶ", () => {
    const doc = { id: "7", name: "日記", updatedAt: "2026-07-07T00:00:00.000Z", _deleted: false };
    const wire = tagPush(crypto, doc);
    expect(wire.name).not.toBe("日記");
    expect(wire.updatedAt).toBe("2026-07-07T00:00:00.000Z");
    expect(wire.nameFingerprint).toBe(crypto.fingerprint("日記"));
    expect(tagPush(crypto, doc).nameFingerprint).toBe(wire.nameFingerprint);
    expect(tagPull(crypto, wire)).toEqual(doc);
  });

  test("chunkUserTag 往復（name 暗号・fingerprint・chunkId 保持）。wire は updatedAt を運ぶ", () => {
    const doc = {
      id: "3",
      chunkId: "42",
      name: "旅行",
      updatedAt: "2026-07-07T00:00:00.000Z",
      _deleted: false,
    };
    const wire = userTagPush(crypto, doc);
    expect(wire.chunkId).toBe("42");
    expect(wire.name).not.toBe("旅行");
    expect(wire.updatedAt).toBe("2026-07-07T00:00:00.000Z");
    expect(wire.nameFingerprint).toBe(crypto.fingerprint("旅行"));
    expect(userTagPull(crypto, wire)).toEqual(doc);
  });

  test("link は構造情報のみのため wire でも平文で往復する（#77 の判断）", () => {
    const doc: LinkDocData = {
      id: "3-7",
      fromChunkId: "3",
      toChunkId: "7",
      score: 1,
      origin: "manual",
      updatedAt: "2026-07-07T00:00:00.000Z",
      _deleted: false,
    };
    const wire = linkPush(doc);
    expect(wire).toEqual(doc);
    expect(linkPull(wire)).toEqual(doc);
  });
});
