/** RAG snapshot 的进程内生命周期；索引正文由调用方持有，本类只管理版本与 TTL。 */
export type SnapshotCacheEntry<T> = {
  revision: string;
  value: T;
  createdAt: number;
  lastAccessAt: number;
};

export type SnapshotCacheOptions = {
  ttlMs?: number;
  now?: () => number;
};

export type SnapshotCacheResult<T> = {
  value: T;
  hit: boolean;
  reason: 'miss' | 'hit' | 'revision-changed' | 'expired';
};

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class RagSnapshotCache<T> {
  private readonly entries = new Map<string, SnapshotCacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: SnapshotCacheOptions = {}) {
    this.ttlMs = Math.max(1, Number(options.ttlMs ?? DEFAULT_TTL_MS));
    this.now = options.now ?? Date.now;
  }

  getOrCreate(key: string, revision: string, create: () => T): SnapshotCacheResult<T> {
    const current = this.now();
    const existing = this.entries.get(key);
    if (existing && existing.revision === revision && current - existing.lastAccessAt < this.ttlMs) {
      existing.lastAccessAt = current;
      return { value: existing.value, hit: true, reason: 'hit' };
    }

    const reason: SnapshotCacheResult<T>['reason'] = !existing
      ? 'miss'
      : current - existing.lastAccessAt >= this.ttlMs
        ? 'expired'
        : 'revision-changed';
    const value = create();
    this.entries.set(key, { revision, value, createdAt: current, lastAccessAt: current });
    return { value, hit: false, reason };
  }

  invalidate(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  size(): number {
    return this.entries.size;
  }
}
