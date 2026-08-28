export type RagIndexCacheOptions = {
  ttlMs?: number;
  now?: () => number;
};

export type RagIndexCacheEntry = {
  revision: string;
  createdAt: number;
  lastAccessAt: number;
};

export type RagIndexCacheLookup = {
  hit: boolean;
  reason: "miss" | "hit" | "revision-changed" | "expired";
  entry?: RagIndexCacheEntry;
};

export type RagIndexCacheStats = {
  entries: number;
  hits: number;
  misses: number;
  expired: number;
  revisionChanges: number;
};

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * TS RAG 索引的生命周期缓存。
 *
 * 索引正文由常驻 worker 持有；本类只记录 scope/revision 的有效性和访问
 * TTL，不复制正文、不参与权限判断，也不把 TTL 失效误当成数据删除。
 */
export class RagIndexCacheService {
  private readonly entries = new Map<string, RagIndexCacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private expired = 0;
  private revisionChanges = 0;

  constructor(options: RagIndexCacheOptions = {}) {
    this.ttlMs = Math.max(1, Number(options.ttlMs ?? DEFAULT_TTL_MS));
    this.now = options.now ?? Date.now;
  }

  lookup(scopeKey: string, revision: string): RagIndexCacheLookup {
    const current = this.now();
    const entry = this.entries.get(scopeKey);
    if (entry && entry.revision === revision && current - entry.lastAccessAt < this.ttlMs) {
      entry.lastAccessAt = current;
      this.hits += 1;
      return { hit: true, reason: "hit", entry };
    }

    const reason: RagIndexCacheLookup["reason"] = !entry
      ? "miss"
      : current - entry.lastAccessAt >= this.ttlMs
        ? "expired"
        : "revision-changed";
    this.misses += 1;
    if (reason === "expired") this.expired += 1;
    if (reason === "revision-changed") this.revisionChanges += 1;
    return { hit: false, reason, entry };
  }

  commit(scopeKey: string, revision: string): void {
    const current = this.now();
    this.entries.set(scopeKey, { revision, createdAt: current, lastAccessAt: current });
  }

  invalidate(scopeKey?: string): void {
    if (scopeKey === undefined) this.entries.clear();
    else this.entries.delete(scopeKey);
  }

  stats(): RagIndexCacheStats {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      expired: this.expired,
      revisionChanges: this.revisionChanges,
    };
  }

  size(): number {
    return this.entries.size;
  }
}
