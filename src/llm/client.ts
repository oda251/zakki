import { ResultAsync } from "neverthrow";
import * as v from "valibot";
import { errorMessage } from "@/util/error.ts";

/**
 * 汎用ローカル LLM（docs/FEATURES.md §ローカル LLM）。導入は任意であり、
 * 全機能が LLM なしで成立する（呼び出し側が決定的フォールバックを持つ）。
 *
 * OpenAI 互換 API（`/v1/chat/completions`）を喋るため、ランタイムを問わない:
 * Ollama（:11434）・LM Studio（:1234）・llama.cpp server・LiteLLM など、
 * OpenAI 互換エンドポイントなら何でも差し替えられる。
 */

export interface LlmError {
  readonly type: "llm-error";
  readonly message: string;
  readonly cause?: unknown;
}

export interface TextGenerator {
  readonly name: string;
  generate(prompt: string): ResultAsync<string, LlmError>;
}

/** 自動検出で順に試す既定エンドポイント（LM Studio → Ollama） */
const KNOWN_BASE_URLS = ["http://127.0.0.1:1234/v1", "http://127.0.0.1:11434/v1"];

const toLlmError = (cause: unknown): LlmError => ({
  type: "llm-error",
  message: errorMessage(cause),
  cause,
});

const ChatResponse = v.object({
  choices: v.tupleWithRest([v.object({ message: v.object({ content: v.string() }) })], v.unknown()),
});
const ModelsResponse = v.object({
  data: v.optional(v.array(v.object({ id: v.optional(v.string()) })), []),
});

/**
 * OpenAI 互換チャット補完クライアント。baseUrl は `/v1` まで含めたもの
 * （例: http://127.0.0.1:1234/v1）。model 未指定時はサーバの最初のモデルに委ねる。
 */
export function createOpenAIGenerator(baseUrl: string, model: string): TextGenerator {
  return {
    name: `openai:${model}`,
    generate: (prompt) =>
      ResultAsync.fromPromise(
        (async () => {
          const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: prompt }],
              stream: false,
            }),
          });
          if (!response.ok) {
            throw new Error(`llm: HTTP ${response.status}`);
          }
          const body = v.parse(ChatResponse, await response.json());
          return body.choices[0].message.content.trim();
        })(),
        toLlmError,
      ),
  };
}

/** `/v1/models` に応答するモデル id 一覧。接続不可・異常時は null */
async function listModels(baseUrl: string): Promise<string[] | null> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) {
      return null;
    }
    const body = v.parse(ModelsResponse, await response.json());
    return body.data.flatMap((m) => (m.id === undefined ? [] : [m.id]));
  } catch {
    return null;
  }
}

/**
 * 使える OpenAI 互換 LLM があれば TextGenerator を返す。なければ null
 * （呼び出し側は決定的フォールバックへ）。
 *
 * 優先順位:
 * 1. `ZAKKI_LLM_BASE_URL`（+ 任意の `ZAKKI_LLM_MODEL`）が指定されていればそれ
 * 2. 既知のローカルランタイム（LM Studio → Ollama）を順にプローブし、
 *    モデルが応答した最初のものを採用
 */
export async function detectLlm(): Promise<TextGenerator | null> {
  const envBase = process.env["ZAKKI_LLM_BASE_URL"];
  const envModel = process.env["ZAKKI_LLM_MODEL"];
  if (envBase !== undefined && envBase !== "") {
    const model = envModel ?? (await firstModel(envBase));
    return model === null ? null : createOpenAIGenerator(envBase, model);
  }
  for (const base of KNOWN_BASE_URLS) {
    const model = envModel ?? (await firstModel(base));
    if (model !== null) {
      return createOpenAIGenerator(base, model);
    }
  }
  return null;
}

async function firstModel(baseUrl: string): Promise<string | null> {
  const models = await listModels(baseUrl);
  return models === null || models[0] === undefined ? null : models[0];
}
