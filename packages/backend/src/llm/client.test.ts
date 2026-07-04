import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createOpenAIGenerator, detectLlm } from "./client.ts";

// Bun.serve で OpenAI 互換 API（LM Studio / Ollama いずれも同形）を模す
let models: string[] = ["qwen3-4b"];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return Response.json({ data: models.map((id) => ({ id })) });
    }
    if (url.pathname === "/v1/chat/completions") {
      return Response.json({
        choices: [{ message: { role: "assistant", content: " 要約です。 " } }],
      });
    }
    return new Response("not found", { status: 404 });
  },
});
const baseUrl = `http://127.0.0.1:${server.port}/v1`;

beforeEach(() => {
  models = ["qwen3-4b"];
  delete process.env["ZAKKI_LLM_BASE_URL"];
  delete process.env["ZAKKI_LLM_MODEL"];
});

afterAll(() => {
  void server.stop();
});

describe("createOpenAIGenerator", () => {
  test("chat/completions の content を trim して返す", async () => {
    const llm = createOpenAIGenerator(baseUrl, "qwen3-4b");
    const result = await llm.generate("こんにちは");
    expect(result._unsafeUnwrap()).toBe("要約です。");
    expect(llm.name).toBe("openai:qwen3-4b");
  });

  test("接続不可はエラー", async () => {
    const llm = createOpenAIGenerator("http://127.0.0.1:1/v1", "x");
    expect((await llm.generate("x")).isErr()).toBe(true);
  });
});

describe("detectLlm", () => {
  test("ZAKKI_LLM_BASE_URL 指定時はそのサーバの最初のモデルを使う", async () => {
    process.env["ZAKKI_LLM_BASE_URL"] = baseUrl;
    const llm = await detectLlm();
    expect(llm?.name).toBe("openai:qwen3-4b");
  });

  test("ZAKKI_LLM_MODEL でモデルを上書きできる", async () => {
    process.env["ZAKKI_LLM_BASE_URL"] = baseUrl;
    process.env["ZAKKI_LLM_MODEL"] = "gpt-oss";
    expect((await detectLlm())?.name).toBe("openai:gpt-oss");
  });

  test("指定サーバにモデルがなければ null", async () => {
    process.env["ZAKKI_LLM_BASE_URL"] = baseUrl;
    models = [];
    expect(await detectLlm()).toBeNull();
  });

  test("既知ランタイムが全滅なら null（自動検出失敗）", async () => {
    // 既定ポート（1234 / 11434）に何もない環境を想定
    expect(await detectLlm()).toBeNull();
  });
});
