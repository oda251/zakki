import type { Context } from "hono";
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

/** 整数のパスパラメータ。数値でなければ null（呼び出し側で 400） */
export function intParam(c: Context, name: string): number | null {
  const value = Number(c.req.param(name));
  return Number.isInteger(value) ? value : null;
}
