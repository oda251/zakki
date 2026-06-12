import { afterAll, describe, expect, test } from "bun:test";
import { createOllamaGenerator, detectOllama } from "./client.ts";

// Bun.serve で Ollama API を模したフェイクサーバ
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/tags") {
      return Response.json({ models: [{ name: "qwen3:4b" }] });
    }
    if (url.pathname === "/api/generate") {
      return Response.json({ response: " 要約です。 " });
    }
    return new Response("not found", { status: 404 });
  },
});
const host = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  void server.stop();
});

describe("detectOllama", () => {
  test("モデルがあれば generator を返す", async () => {
    const llm = await detectOllama(host, "qwen3:4b");
    expect(llm?.name).toBe("ollama:qwen3:4b");
  });

  test("モデル未取得なら null", async () => {
    expect(await detectOllama(host, "llama99:70b")).toBeNull();
  });

  test("接続不可なら null", async () => {
    expect(await detectOllama("http://127.0.0.1:1", "qwen3:4b")).toBeNull();
  });
});

describe("createOllamaGenerator", () => {
  test("generate は応答を trim して返す", async () => {
    const llm = createOllamaGenerator(host, "qwen3:4b");
    const result = await llm.generate("こんにちは");
    expect(result._unsafeUnwrap()).toBe("要約です。");
  });

  test("接続不可はエラー", async () => {
    const llm = createOllamaGenerator("http://127.0.0.1:1", "qwen3:4b");
    const result = await llm.generate("x");
    expect(result.isErr()).toBe(true);
  });
});
