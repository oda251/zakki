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

function createPlaintextIndex(db: IDBDatabase): PlaintextIndex {
  return {
    db,

    async putChunk(c) {
      const tx = db.transaction("chunks", "readwrite");
      tx.objectStore("chunks").put(c);
      await wrapTx(tx);
    },

    getChunk(id) {
      const tx = db.transaction("chunks", "readonly");
      return wrapRequest<IndexedChunk | undefined>(tx.objectStore("chunks").get(id));
    },

    async deleteChunk(id) {
      const tx = db.transaction("chunks", "readwrite");
      tx.objectStore("chunks").delete(id);
      await wrapTx(tx);
    },

    getAllChunks() {
      const tx = db.transaction("chunks", "readonly");
      return wrapRequest<IndexedChunk[]>(tx.objectStore("chunks").getAll());
    },

    async getChildren(parentId) {
      // IndexedDB の index は null キーを含めないため、日付チャンク（parentId=null）は全走査する
      if (parentId === null) {
        const all = await this.getAllChunks();
        return all.filter((c) => c.parentId === null).toSorted(byPosition);
      }
      const tx = db.transaction("chunks", "readonly");
      const index = tx.objectStore("chunks").index("by_parent");
      const items = await wrapRequest<IndexedChunk[]>(index.getAll(parentId));
      return items.toSorted(byPosition);
    },

    async putUserTag(t) {
      const tx = db.transaction("chunk_user_tags", "readwrite");
      tx.objectStore("chunk_user_tags").put(t);
      await wrapTx(tx);
    },

    getUserTagsByChunk(chunkId) {
      const tx = db.transaction("chunk_user_tags", "readonly");
      const index = tx.objectStore("chunk_user_tags").index("by_chunk");
      return wrapRequest<IndexedUserTag[]>(index.getAll(chunkId));
    },

    async deleteUserTag(id) {
      const tx = db.transaction("chunk_user_tags", "readwrite");
      tx.objectStore("chunk_user_tags").delete(id);
      await wrapTx(tx);
    },

    async putTag(t) {
      const tx = db.transaction("tags", "readwrite");
      tx.objectStore("tags").put(t);
      await wrapTx(tx);
    },

    getTag(id) {
      const tx = db.transaction("tags", "readonly");
      return wrapRequest<IndexedTag | undefined>(tx.objectStore("tags").get(id));
    },

    async deleteTag(id) {
      const tx = db.transaction("tags", "readwrite");
      tx.objectStore("tags").delete(id);
      await wrapTx(tx);
    },

    async putCorrection(c) {
      const tx = db.transaction("corrections", "readwrite");
      tx.objectStore("corrections").put(c);
      await wrapTx(tx);
    },

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

    async setCursor(value) {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put({ key: "cursor", value } satisfies MetaRow);
      await wrapTx(tx);
    },

    close() {
      db.close();
    },
  };
}
