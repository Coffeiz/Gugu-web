/**
 * 通用 TTL + LRU 值缓存，收编 worker 内各处手写的 Map + lastAccess + 超限驱逐。
 *
 * 语义：
 * - TTL 为滑动窗口：每次 get 命中都刷新存活时间；
 * - ttlMs 传 Infinity 表示不过期（仅受 maxEntries LRU 约束）；
 * - 超过 maxEntries 时按插入序驱逐最旧条目（Map 保持插入序）；
 * - 过期检查是惰性的（get/set 时触发），没有后台清扫定时器。
 */
export type TtlCacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
};

type Entry<V> = { value: V; expiresAt: number };

export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  readonly ttlMs: number;
  readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: TtlCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? Infinity;
    this.maxEntries = Math.max(1, options.maxEntries ?? 64);
    this.now = options.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    const current = this.now();
    if (current >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    /* LRU 触及即刷新（删除重插保持 Map 插入序 = 访问序）；滑动 TTL 同步续期，活跃条目不过期 */
    this.entries.delete(key);
    if (Number.isFinite(this.ttlMs)) {
      entry.expiresAt = current + this.ttlMs;
    }
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    const expiresAt = Number.isFinite(this.ttlMs) ? this.now() + this.ttlMs : Infinity;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
