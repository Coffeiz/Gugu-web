import assert from "node:assert/strict";
import test from "node:test";
import { TtlCache } from "../src/ttl-cache.ts";

test("TtlCache 滑动 TTL：每次命中续期，静默期满才过期", () => {
  const minute = 60_000;
  let now = 0;
  const cache = new TtlCache<string>({ ttlMs: 30 * minute, now: () => now });

  cache.set("hot", "v");
  now = 29 * minute;
  assert.equal(cache.get("hot"), "v");
  // 命中已续期到 59min：58min 仍在窗口内（固定 TTL 语义下这里会被误杀）。
  now = 58 * minute;
  assert.equal(cache.get("hot"), "v");
  // 上次命中后再静默 32min → 过期。
  now = 90 * minute;
  assert.equal(cache.get("hot"), undefined);

  // 从未命中的条目：满 30min 即过期。
  cache.set("cold", "v");
  now = 120 * minute + 1;
  assert.equal(cache.get("cold"), undefined);
});

test("TtlCache Infinity TTL 不过期，LRU 照常驱逐", () => {
  const minute = 60_000;
  let now = 0;
  const cache = new TtlCache<string>({ ttlMs: Infinity, maxEntries: 2, now: () => now });

  cache.set("a", "1");
  cache.set("b", "2");
  now = 60 * minute;
  assert.equal(cache.get("a"), "1");
  cache.set("c", "3");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "1");
  assert.equal(cache.get("c"), "3");
});
