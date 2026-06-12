import { ResultAsync } from "neverthrow";
import * as v from "valibot";

/**
 * 汎用ローカル LLM（docs/FEATURES.md §ローカル LLM）。導入は任意であり、
 * 全機能が LLM なしで成立する（呼び出し側が決定的フォールバックを持つ）。
 * ランタイムは Ollama（REST、最小摩擦）を使う。
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

export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen3:4b";

const toLlmError = (cause: unknown): LlmError => ({
  type: "llm-error",
  message: cause instanceof Error ? cause.message : String(cause),
  cause,
});

const GenerateResponse = v.object({ response: v.string() });
const TagsResponse = v.object({
  models: v.optional(v.array(v.object({ name: v.optional(v.string()) })), []),
});

export function createOllamaGenerator(
  host: string = DEFAULT_OLLAMA_HOST,
  model: string = DEFAULT_OLLAMA_MODEL,
): TextGenerator {
  return {
    name: `ollama:${model}`,
    generate: (prompt) =>
      ResultAsync.fromPromise(
        (async () => {
          const response = await fetch(`${host}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, prompt, stream: false }),
          });
          if (!response.ok) {
            throw new Error(`ollama: HTTP ${response.status}`);
          }
          const body = v.parse(GenerateResponse, await response.json());
          return body.response.trim();
        })(),
        toLlmError,
      ),
  };
}

/**
 * Ollama が起動していてモデルが取得済みなら TextGenerator を返す。
 * 接続不可・モデル未取得なら null（呼び出し側は決定的フォールバックへ）。
 */
export async function detectOllama(
  host: string = DEFAULT_OLLAMA_HOST,
  model: string = DEFAULT_OLLAMA_MODEL,
): Promise<TextGenerator | null> {
  try {
    const response = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) {
      return null;
    }
    const body = v.parse(TagsResponse, await response.json());
    const found = body.models.some(
      (m) => m.name === model || m.name?.startsWith(`${model.split(":")[0]}:`),
    );
    return found ? createOllamaGenerator(host, model) : null;
  } catch {
    return null;
  }
}
