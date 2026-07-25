import { describe, expect, test } from "bun:test";
import { ancoAssetPlan, staleAncoCaches } from "./load.ts";

// ref 連動キャッシュの純粋部分（issue #89）。fetch / Cache API に触れる経路は
// ブラウザ実機（M6 レビュー）で確認し、ここでは URL 導出と旧キャッシュ選別を検証する。

describe("ancoAssetPlan", () => {
  test("ref をクエリ ?v= と Cache API 名に反映する", () => {
    const plan = ancoAssetPlan("v0.11.2");
    expect(plan.wasmUrl).toBe("/anco/anco.reactor.wasm.br?v=v0.11.2");
    expect(plan.dictUrl).toBe("/anco/dict.tar.br?v=v0.11.2");
    expect(plan.cacheName).toBe("zakki-anco-v0.11.2");
  });

  test("ref が変われば URL・キャッシュ名も変わる（キャッシュバスティング）", () => {
    const a = ancoAssetPlan("v0.11.2");
    const b = ancoAssetPlan("v0.12.0");
    expect(b.wasmUrl).not.toBe(a.wasmUrl);
    expect(b.dictUrl).not.toBe(a.dictUrl);
    expect(b.cacheName).not.toBe(a.cacheName);
  });

  test("URL に使えない文字はクエリでエンコードする", () => {
    const plan = ancoAssetPlan("feat/branch#1");
    expect(plan.wasmUrl).toBe("/anco/anco.reactor.wasm.br?v=feat%2Fbranch%231");
  });
});

describe("staleAncoCaches", () => {
  test("zakki-anco- プレフィックスのうち現行以外だけを選ぶ", () => {
    const names = ["zakki-anco-v0.11.2", "zakki-anco-v0.10.0", "other-cache"];
    expect(staleAncoCaches(names, "zakki-anco-v0.11.2")).toEqual(["zakki-anco-v0.10.0"]);
  });

  test("旧命名 zakki-anco-v1（ref 非連動時代）も破棄対象になる", () => {
    expect(staleAncoCaches(["zakki-anco-v1"], "zakki-anco-v0.11.2")).toEqual(["zakki-anco-v1"]);
  });

  test("現行のみ・無関係のみなら空", () => {
    expect(staleAncoCaches(["zakki-anco-v0.11.2"], "zakki-anco-v0.11.2")).toEqual([]);
    expect(staleAncoCaches(["workbox-precache"], "zakki-anco-v0.11.2")).toEqual([]);
  });
});
