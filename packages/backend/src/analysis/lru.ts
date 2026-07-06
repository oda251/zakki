/**
 * Map の挿入順序を利用した簡潔な LRU キャッシュ（issue #54）。
 * get / set で使ったキーを末尾へ移動し、上限超過時は最古（先頭）を捨てる。
 * 長寿命プロセス（web サーバ）でのキャッシュ無制限成長を防ぐ。
 */
export class LruCache<K, V> {
  private readonly limit: number;
  private readonly map = new Map<K, V>();

  constructor(limit: number) {
    this.limit = limit;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // 再挿入で「最近使った」側（挿入順序の末尾）へ移す
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      for (const oldest of this.map.keys()) {
        this.map.delete(oldest);
        break;
      }
    }
  }
}
