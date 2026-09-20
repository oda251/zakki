import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateDek } from "@zakki/core/crypto/dek.ts";
import { ready } from "@zakki/core/crypto/sodium.ts";
import { makeFieldCrypto, plaintextFieldCrypto } from "@zakki/web/client/db/crypto.ts";
import type { FileDoc, ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { filePull, filePush } from "@zakki/web/client/db/modifiers.ts";
import { openTestDb } from "@zakki/web/client/db/test-db.ts";
import { getOrCreateDateChunkDoc, saveChildrenDocs } from "@zakki/web/client/db/writes.ts";

/** issue #157: files コレクションの wire 変換と、テキスト投影の blob 保護 */
let db: ZakkiDatabase;

beforeAll(async () => {
  await ready();
});

beforeEach(async () => {
  db = await openTestDb(`filedocs-${Math.random().toString(36).slice(2)}`);
});

afterEach(async () => {
  await db.remove();
});

const doc = (): FileDoc & { _deleted: boolean } => ({
  id: "1758000000000001",
  name: "秘密のメモ",
  extension: "png",
  encryption: "none",
  objectKey: "accounts/acc/1758000000000001",
  size: 100,
  partSize: 33_554_432,
  updatedAt: "2026-09-20T00:00:00.000Z",
  _deleted: false,
});

describe("F5: filePush / filePull", () => {
  test("暗号 ON では name が暗号化され、復号して往復する", () => {
    const fc = makeFieldCrypto(generateDek());
    const wire = filePush(fc, doc());
    expect(wire.name).not.toBe("秘密のメモ");
    // 拡張子・サイズはメタデータとして平文のまま（弁別に使う）
    expect(wire.extension).toBe("png");
    expect(filePull(fc, wire)).toEqual(doc());
  });

  test("暗号 OFF では恒等変換", () => {
    const fc = plaintextFieldCrypto();
    expect(filePush(fc, doc()).name).toBe("秘密のメモ");
    expect(filePull(fc, filePush(fc, doc()))).toEqual(doc());
  });
});

describe("F6: テキスト投影は blob チャンク doc を消さない", () => {
  test("saveChildrenDocs の後も blob チャンクが残る", async () => {
    const root = await getOrCreateDateChunkDoc(db, "2026-09-20");
    await saveChildrenDocs(db, root.id, [{ content: "一。" }, { content: "二。" }]);
    await db.chunks.insert({
      id: "1758000000000009",
      parentId: root.id,
      position: 1_000_000,
      kind: "blob",
      fileId: "1758000000000001",
      content: "",
      date: null,
      polarity: null,
      updatedAt: "2026-09-20T00:00:00.000Z",
    });

    const saved = await saveChildrenDocs(db, root.id, [{ content: "一改。" }]);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.position).toBe(0);
    expect(await db.chunks.findOne("1758000000000009").exec()).not.toBeNull();
  });
});
