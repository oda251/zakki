import * as v from "valibot";

/** JSON ボディを valibot で検証する。失敗は null（呼び出し側で 400） */
export async function parseBody<T extends v.GenericSchema>(
  req: Request,
  schema: T,
): Promise<v.InferOutput<T> | null> {
  const body: unknown = await req.json().catch(() => null);
  const parsed = v.safeParse(schema, body);
  return parsed.success ? parsed.output : null;
}
