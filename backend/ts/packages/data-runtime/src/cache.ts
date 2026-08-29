export type DataCacheEntry<T> = {
  revision: string;
  value: T;
  createdAt: number;
  lastAccessAt: number;
};

export type DataCacheResult<T> = {
  hit: boolean;
  reason: "miss" | "hit" | "revision-changed" | "expired";
  value?: T;
};

export type DataCacheOptions = {
  ttlMs?: number;
  now?: () => number;
};

export type DataCacheInvalidation = {
  ownerId?: string;
  scopeType?: string;
  scopeId?: string;
  source?: string;
};

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** 只缓存已授权读取结果；缓存键必须由调用方包含 owner、scope 和 source。 */
export class DataRuntimeCache<T> {
  private readonly entries = new Map<string, DataCacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: DataCacheOptions = {}) {
    this.ttlMs = Math.max(1, Number(options.ttlMs ?? DEFAULT_TTL_MS));
    this.now = options.now ?? Date.now;
  }

  get(key: string, revision: string): DataCacheResult<T> {
    const entry = this.entries.get(key);
    const now = this.now();
    if (entry && entry.revision === revision && now - entry.lastAccessAt < this.ttlMs) {
      entry.lastAccessAt = now;
      return { hit: true, reason: "hit", value: entry.value };
    }
    if (!entry) return { hit: false, reason: "miss" };
    return {
      hit: false,
      reason: now - entry.lastAccessAt >= this.ttlMs ? "expired" : "revision-changed",
    };
  }

  set(key: string, revision: string, value: T): void {
    const now = this.now();
    this.entries.set(key, { revision, value, createdAt: now, lastAccessAt: now });
  }

  invalidate(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  invalidateWhere(predicate: (key: string, entry: DataCacheEntry<T>) => boolean): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (!predicate(key, entry)) continue;
      this.entries.delete(key);
      removed += 1;
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }
}
