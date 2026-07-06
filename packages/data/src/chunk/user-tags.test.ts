import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { getOrCreateDateChunk, saveChildren } from "./repository.ts";
import { listUserTagsByChunk, setChunkUserTags } from "./user-tags.ts";

let db: Db;
let chunkId: number;

beforeEach(async () => {
  db = await createDb(":memory:");
  const root = (await getOrCreateDateChunk(db, "2026-07-06"))._unsafeUnwrap();
  const [chunk] = (await saveChildren(db, root.id, [{ content: "調査" }]))._unsafeUnwrap();
  if (chunk === undefined) throw new Error("seed 不足");
  chunkId = chunk.id;
});

describe("setChunkUserTags", () => {
  test("全置換・重複と空白のみは除去", async () => {
    (await setChunkUserTags(db, chunkId, ["web", "web", " ", "調査"]))._unsafeUnwrap();
    expect((await listUserTagsByChunk(db))._unsafeUnwrap().get(chunkId)).toEqual(["web", "調査"]);

    (await setChunkUserTags(db, chunkId, ["別"]))._unsafeUnwrap();
    expect((await listUserTagsByChunk(db))._unsafeUnwrap().get(chunkId)).toEqual(["別"]);
  });

  test("空指定で全削除", async () => {
    (await setChunkUserTags(db, chunkId, ["web"]))._unsafeUnwrap();
    (await setChunkUserTags(db, chunkId, []))._unsafeUnwrap();
    expect((await listUserTagsByChunk(db))._unsafeUnwrap().get(chunkId)).toBeUndefined();
  });
});
