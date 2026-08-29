import assert from "node:assert/strict";
import test from "node:test";
import { RagIndexCacheService } from "../src/index-cache-service.ts";

test("TS RAG index cache 按 revision 和 TTL 管理索引有效性", () => {
  let now = 0;
  const cache = new RagIndexCacheService({ ttlMs: 100, now: () => now });

  assert.equal(cache.lookup("owner:o1", "r1").reason, "miss");
  cache.commit("owner:o1", "r1");
  now = 90;
  assert.equal(cache.lookup("owner:o1", "r1").reason, "hit");
  now = 200;
  assert.equal(cache.lookup("owner:o1", "r1").reason, "expired");
  cache.commit("owner:o1", "r2");
  assert.equal(cache.lookup("owner:o1", "r3").reason, "revision-changed");
  assert.deepEqual(cache.stats(), { entries: 1, hits: 1, misses: 3, expired: 1, revisionChanges: 1 });
});
