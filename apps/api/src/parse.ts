import * as v from "valibot";

/**
 * JSON ボディを valibot で検証する（apps/web/src/server/parse.ts と同じ流儀）。
 * 失敗（JSON として壊れている / スキーマ不一致）は null で、呼び出し側が 400 を返す。
 * apps/web の実装を共有しないのは depcruise `api-control-plane-standalone` により
 * apps/api が他 app に依存できないため（コントロールプレーンは独立して deploy される）。
 */
export async function parseBody<T extends v.GenericSchema>(
  req: Request,
  schema: T,
): Promise<v.InferOutput<T> | null> {
  const body: unknown = await req.json().catch(() => null);
  const parsed = v.safeParse(schema, body);
  return parsed.success ? parsed.output : null;
}
