import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { openTestDb } from "@zakki/web/client/db/test-db.ts";
import { numId } from "@zakki/web/client/db/ids.ts";
import { getOrCreateDateChunkDoc, saveChildrenDocs } from "@zakki/web/client/db/writes.ts";
import { connectRouter } from "@zakki/web/client/router/controller.ts";
import { currentHref } from "@zakki/web/client/router/history.ts";
import { gotoChunk } from "@zakki/web/client/router/navigate.ts";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

/**
 * issue #52 受け入れ基準の統合検証:
 * - /c/:id?select=&tag= のディープリンクからバッファ（該当階層）が復元される
 * - 戻る/進むがドリル履歴として機能する（popstate でバッファが追随する）
 * - Escape（drillUp）が親チャンクへの URL 遷移になる
 * bun test に DOM は無いため、History API の最小スタブを window に注入して
 * controller（imperative shell）をそのまま動かす。
 */

interface WindowStub extends EventTarget {
  location: { pathname: string; search: string };
  history: {
    pushState: (state: unknown, unused: string, url?: string | URL | null) => void;
    replaceState: (state: unknown, unused: string, url?: string | URL | null) => void;
    back: () => void;
    forward: () => void;
  };
  addEventListener: EventTarget["addEventListener"];
  removeEventListener: EventTarget["removeEventListener"];
  dispatchEvent: EventTarget["dispatchEvent"];
}

function makeWindowStub(initialHref: string): WindowStub {
  const target = new EventTarget();
  const entries: string[] = [initialHref];
  let index = 0;
  const popstate = () => target.dispatchEvent(new Event("popstate"));
  const stub: WindowStub = {
    get location() {
      const url = new URL(entries[index] ?? "/", "http://zakki.test");
      return { pathname: url.pathname, search: url.search };
    },
    history: {
      pushState: (_state, _unused, url) => {
        entries.splice(index + 1);
        entries.push(String(url));
        index += 1;
      },
      replaceState: (_state, _unused, url) => {
        entries[index] = String(url);
      },
      back: () => {
        if (index === 0) return;
        index -= 1;
        popstate();
      },
      forward: () => {
        if (index >= entries.length - 1) return;
        index += 1;
        popstate();
      },
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  return stub;
}

const globals = globalThis as { window?: unknown; document?: unknown };
let stub: WindowStub;
let dbs: ZakkiDatabase[] = [];
let disconnects: (() => void)[] = [];

function install(initialHref: string): void {
  stub = makeWindowStub(initialHref);
  globals.window = stub;
  globals.document = { activeElement: null };
}

async function open(): Promise<ZakkiDatabase> {
  const db = await openTestDb();
  dbs.push(db);
  return db;
}

/** バッファのロード（openChunk / openToday）が settle するのを待つ */
async function settled(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

beforeEach(() => {
  useBufferStore.setState({
    db: null,
    currentId: null,
    initialRaw: null,
    initialChunkIds: [],
    error: null,
  });
  useGraphStore.setState({ data: null, error: null });
});

afterEach(async () => {
  for (const disconnect of disconnects) disconnect();
  disconnects = [];
  await Promise.all(dbs.map((db) => db.remove()));
  dbs = [];
  delete globals.window;
  delete globals.document;
});

const T1 = "2026-07-07T00:00:01.000Z";

describe("connectRouter", () => {
  test("受け入れ基準: /c/:id?select=&tag= のディープリンクでバッファが復元される", async () => {
    const db = await open();
    useBufferStore.getState().connect(db);
    const parent = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    const children = await saveChildrenDocs(db, parent.id, [{ content: "一" }], T1);

    install(`/c/${numId(parent.id)}?select=${numId(children[0]?.id ?? "")}&tag=x`);
    disconnects.push(connectRouter());
    await settled();

    const state = useBufferStore.getState();
    expect(state.currentId).toBe(numId(parent.id));
    expect(state.initialChunkIds).toEqual([numId(children[0]?.id ?? "")]);
  });

  test("受け入れ基準: 戻る/進むがドリル履歴として機能する（バッファが追随する）", async () => {
    const db = await open();
    useBufferStore.getState().connect(db);
    const parent = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    const children = await saveChildrenDocs(db, parent.id, [{ content: "子" }], T1);
    const parentId = numId(parent.id);
    const childId = numId(children[0]?.id ?? "");

    install(`/c/${parentId}`);
    disconnects.push(connectRouter());
    await settled();
    expect(useBufferStore.getState().currentId).toBe(parentId);

    gotoChunk(childId);
    await settled();
    expect(currentHref()).toBe(`/c/${childId}`);
    expect(useBufferStore.getState().currentId).toBe(childId);

    stub.history.back();
    await settled();
    expect(currentHref()).toBe(`/c/${parentId}`);
    expect(useBufferStore.getState().currentId).toBe(parentId);

    stub.history.forward();
    await settled();
    expect(useBufferStore.getState().currentId).toBe(childId);
  });

  test("Escape は親チャンクへの URL 遷移（元のドリル位置を選択状態にする）", async () => {
    const db = await open();
    useBufferStore.getState().connect(db);
    const parent = await getOrCreateDateChunkDoc(db, "2026-07-07", T1);
    const children = await saveChildrenDocs(db, parent.id, [{ content: "子" }], T1);
    const parentId = numId(parent.id);
    const childId = numId(children[0]?.id ?? "");
    // parentOf はグラフ（liveQuery 導出）から引くため data を用意する
    disconnects.push(useGraphStore.getState().connect(db));

    install(`/c/${childId}`);
    disconnects.push(connectRouter());
    await settled();

    stub.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
    await settled();
    expect(currentHref()).toBe(`/c/${parentId}?select=${childId}`);
    expect(useBufferStore.getState().currentId).toBe(parentId);

    // 日付チャンク（親なし）からの Escape はトップレベル（/all）へ。バッファは当日のまま
    stub.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
    await settled();
    expect(currentHref()).toBe(`/all?select=${parentId}`);
  });
});
