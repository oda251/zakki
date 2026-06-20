import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { saveSnapshot } from "@zakki/data/entry/repository.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import { bufferToVector, cosine, vectorToBuffer } from "./vector.ts";
import { addSemanticLinks, nearestChunks } from "./semantic.ts";
import { loadVectors, syncChunkEmbeddings } from "./store.ts";

let db: Db;
let embedCalls: string[][];

/** テキスト先頭文字で方向が決まる決定的フェイク embedder */
const fakeEmbedder: Embedder = {
  name: "fake",
  embed: (texts) => {
    embedCalls.push(texts);
    return Promise.resolve(
      texts.map((t) =>
        t.startsWith("あ") ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]),
      ),
    );
  },
};

function seed(contents: string[]): void {
  saveSnapshot(db, {
    date: "2026-06-13",
    raw: "",
    converted: contents.join(""),
    chunks: contents.map((content) => ({ content })),
  })._unsafeUnwrap();
}

beforeEach(() => {
  db = createDb(":memory:");
  embedCalls = [];
});

describe("ベクトル直列化", () => {
  test("Float32Array ↔ Buffer の往復", () => {
    const vector = Float32Array.from([0.25, -1, 3.5]);
    expect([...bufferToVector(vectorToBuffer(vector))]).toEqual([0.25, -1, 3.5]);
  });
});

describe("syncChunkEmbeddings", () => {
  test("未計算チャンクだけを埋め込み、再実行では何もしない", async () => {
    seed(["あの話。", "別の話。"]);
    const first = (await syncChunkEmbeddings(db, fakeEmbedder))._unsafeUnwrap();
    expect(first.embedded).toBe(2);

    const second = (await syncChunkEmbeddings(db, fakeEmbedder))._unsafeUnwrap();
    expect(second.embedded).toBe(0);
    expect(embedCalls).toHaveLength(1);
  });

  test("内容が変わったチャンクは再計算する", async () => {
    seed(["あの話。"]);
    (await syncChunkEmbeddings(db, fakeEmbedder))._unsafeUnwrap();
    seed(["違う話。"]);
    const resync = (await syncChunkEmbeddings(db, fakeEmbedder))._unsafeUnwrap();
    expect(resync.embedded).toBe(1);
  });
});

describe("addSemanticLinks / nearestChunks", () => {
  test("近傍ペアのみリンクし、既存ペアは増やさない", async () => {
    seed(["あれ。", "あの件。", "別件。"]);
    (await syncChunkEmbeddings(db, fakeEmbedder))._unsafeUnwrap();
    const vectors = loadVectors(db)._unsafeUnwrap();

    // chunk1,2 は同方向（cos=1）、chunk3 は直交（cos=0）
    const added = addSemanticLinks(db, vectors)._unsafeUnwrap();
    expect(added.added).toBe(1);
    expect(addSemanticLinks(db, vectors)._unsafeUnwrap().added).toBe(0);
  });

  test("nearestChunks はスコア降順・自己含む近傍を返す", () => {
    const vectors = new Map<number, Float32Array>([
      [1, Float32Array.from([1, 0])],
      [2, Float32Array.from([0.9, 0.1])],
      [3, Float32Array.from([0, 1])],
    ]);
    const hits = nearestChunks(vectors, Float32Array.from([1, 0]), 2, 0.5);
    expect(hits.map((h) => h.chunkId)).toEqual([1, 2]);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0);
  });
});
