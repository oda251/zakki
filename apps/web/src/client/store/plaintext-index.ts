/**
 * クライアント平文インデックス（IndexedDB ストア本体）。
 * 「渡されるレコードは既に平文」前提の純ストレージ層。復号やサーバ同期はここに含めない
 * （同期カーソルの保持のみ担当し、実際の差分適用は別モジュールで扱う）。
 */

export interface IndexedChunk {
  id: number;
  parentId: number | null;
  position: number;
  content: string;
  date: string | null;
  polarity: number | null;
  updatedAt: string;
}

export interface IndexedUserTag {
  id: number;
  chunkId: number;
  name: string;
}

export interface IndexedTag {
  id: number;
  name: string;
}

export interface IndexedCorrection {
  kana: string;
  chosen: string;
  updatedAt: string;
}

interface MetaRow {
  key: string;
  value: string;
}

export interface IndexDelta {
  chunks?: { upsert?: IndexedChunk[]; delete?: number[] };
  userTags?: { upsert?: IndexedUserTag[]; delete?: number[] };
  tags?: { upsert?: IndexedTag[]; delete?: number[] };
  corrections?: { upsert?: IndexedCorrection[]; delete?: string[] };
  cursor?: string;
}

const DEFAULT_DB_NAME = "zakki-index";
const DB_VERSION = 1;

/** IDBRequest を Promise 化する。`store.get` 等が返す `IDBRequest<any>` は型引数で束ねる */
function wrapRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

/** readwrite トランザクションの完了を待つ（put/delete 系の確定点） */
function wrapTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () => reject(tx.error));
    tx.addEventListener("abort", () => reject(tx.error));
  });
}

const byPosition = (a: IndexedChunk, b: IndexedChunk): number => a.position - b.position;

export interface PlaintextIndex {
  readonly db: IDBDatabase;

  putChunk(c: IndexedChunk): Promise<void>;
  getChunk(id: number): Promise<IndexedChunk | undefined>;
  deleteChunk(id: number): Promise<void>;
  getAllChunks(): Promise<IndexedChunk[]>;
  getChildren(parentId: number | null): Promise<IndexedChunk[]>;

  putUserTag(t: IndexedUserTag): Promise<void>;
  getUserTagsByChunk(chunkId: number): Promise<IndexedUserTag[]>;
  deleteUserTag(id: number): Promise<void>;

  putTag(t: IndexedTag): Promise<void>;
  getTag(id: number): Promise<IndexedTag | undefined>;
  deleteTag(id: number): Promise<void>;

  putCorrection(c: IndexedCorrection): Promise<void>;
  getCorrections(): Promise<Map<string, string>>;

  getCursor(): Promise<string | undefined>;
  setCursor(value: string): Promise<void>;

  applyDelta(delta: IndexDelta): Promise<void>;

  close(): void;
}

export function openPlaintextIndex(name: string = DEFAULT_DB_NAME): Promise<PlaintextIndex> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const db = request.result;

      const chunks = db.createObjectStore("chunks", { keyPath: "id" });
      chunks.createIndex("by_parent", "parentId");

      const userTags = db.createObjectStore("chunk_user_tags", { keyPath: "id" });
      userTags.createIndex("by_chunk", "chunkId");

      db.createObjectStore("tags", { keyPath: "id" });
      db.createObjectStore("corrections", { keyPath: "kana" });
      db.createObjectStore("meta", { keyPath: "key" });
    });

    request.addEventListener("success", () => resolve(createPlaintextIndex(request.result)));
    request.addEventListener("error", () => reject(request.error));
  });
}

/** delta の 1 セクション（upsert→delete の順）を tx 内の store へ適用する */
function applySection(
  tx: IDBTransaction,
  store: string,
  section: { upsert?: unknown[]; delete?: IDBValidKey[] } | undefined,
): void {
  if (section === undefined) return;
  const s = tx.objectStore(store);
  for (const v of section.upsert ?? []) s.put(v);
  for (const k of section.delete ?? []) s.delete(k);
}

function createPlaintextIndex(db: IDBDatabase): PlaintextIndex {
  /** 対象ストアの readwrite tx を張り、fn で操作して完了を待つ（変更系の共通形） */
  const write = (stores: string | string[], fn: (tx: IDBTransaction) => void): Promise<void> => {
    const tx = db.transaction(stores, "readwrite");
    fn(tx);
    return wrapTx(tx);
  };

  return {
    db,

    putChunk: (c) => write("chunks", (tx) => tx.objectStore("chunks").put(c)),
    deleteChunk: (id) => write("chunks", (tx) => tx.objectStore("chunks").delete(id)),

    getChunk(id) {
      const tx = db.transaction("chunks", "readonly");
      return wrapRequest<IndexedChunk | undefined>(tx.objectStore("chunks").get(id));
    },

    getAllChunks() {
      const tx = db.transaction("chunks", "readonly");
      return wrapRequest<IndexedChunk[]>(tx.objectStore("chunks").getAll());
    },

    async getChildren(parentId) {
      // IndexedDB の index は null キーを含めないため、日付チャンク（parentId=null）は全走査する
      const tx = db.transaction("chunks", "readonly");
      if (parentId === null) {
        const all = await wrapRequest<IndexedChunk[]>(tx.objectStore("chunks").getAll());
        return all.filter((c) => c.parentId === null).toSorted(byPosition);
      }
      const index = tx.objectStore("chunks").index("by_parent");
      const items = await wrapRequest<IndexedChunk[]>(index.getAll(parentId));
      return items.toSorted(byPosition);
    },

    putUserTag: (t) => write("chunk_user_tags", (tx) => tx.objectStore("chunk_user_tags").put(t)),
    deleteUserTag: (id) =>
      write("chunk_user_tags", (tx) => tx.objectStore("chunk_user_tags").delete(id)),

    getUserTagsByChunk(chunkId) {
      const tx = db.transaction("chunk_user_tags", "readonly");
      const index = tx.objectStore("chunk_user_tags").index("by_chunk");
      return wrapRequest<IndexedUserTag[]>(index.getAll(chunkId));
    },

    putTag: (t) => write("tags", (tx) => tx.objectStore("tags").put(t)),
    deleteTag: (id) => write("tags", (tx) => tx.objectStore("tags").delete(id)),

    getTag(id) {
      const tx = db.transaction("tags", "readonly");
      return wrapRequest<IndexedTag | undefined>(tx.objectStore("tags").get(id));
    },

    putCorrection: (c) => write("corrections", (tx) => tx.objectStore("corrections").put(c)),
    async getCorrections() {
      const tx = db.transaction("corrections", "readonly");
      const rows = await wrapRequest<IndexedCorrection[]>(tx.objectStore("corrections").getAll());
      return new Map(rows.map((r) => [r.kana, r.chosen]));
    },

    async getCursor() {
      const tx = db.transaction("meta", "readonly");
      const row = await wrapRequest<MetaRow | undefined>(tx.objectStore("meta").get("cursor"));
      return row?.value;
    },
    setCursor: (value) =>
      write("meta", (tx) => tx.objectStore("meta").put({ key: "cursor", value } satisfies MetaRow)),

    applyDelta(delta) {
      const stores: string[] = [];
      if (delta.chunks) stores.push("chunks");
      if (delta.userTags) stores.push("chunk_user_tags");
      if (delta.tags) stores.push("tags");
      if (delta.corrections) stores.push("corrections");
      if (delta.cursor !== undefined) stores.push("meta");
      if (stores.length === 0) return Promise.resolve();

      return write(stores, (tx) => {
        applySection(tx, "chunks", delta.chunks);
        applySection(tx, "chunk_user_tags", delta.userTags);
        applySection(tx, "tags", delta.tags);
        applySection(tx, "corrections", delta.corrections);
        if (delta.cursor !== undefined) {
          tx.objectStore("meta").put({ key: "cursor", value: delta.cursor } satisfies MetaRow);
        }
      });
    },

    close() {
      db.close();
    },
  };
}
