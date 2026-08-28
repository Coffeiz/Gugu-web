import assert from "node:assert/strict";
import test from "node:test";
import { DataRuntimeCache } from "../src/cache.ts";

test("Data Runtime cache 按 revision 和 TTL 复用并失效", () => {
  let now = 0;
  const cache = new DataRuntimeCache<string>({ ttlMs: 100, now: () => now });
  cache.set("owner:o1:source:project", "r1", "项目数据");
  assert.deepEqual(cache.get("owner:o1:source:project", "r1"), { hit: true, reason: "hit", value: "项目数据" });
  assert.equal(cache.get("owner:o1:source:project", "r2").reason, "revision-changed");
  now = 101;
  assert.equal(cache.get("owner:o1:source:project", "r1").reason, "expired");
  assert.equal(cache.size(), 1);
});

test("Data Runtime cache 可以按 key 或整体失效", () => {
  const cache = new DataRuntimeCache<number>();
  cache.set("owner:o1:project", "r1", 1);
  cache.set("owner:o1:file", "r1", 2);
  cache.invalidate("owner:o1:project");
  assert.equal(cache.size(), 1);
  cache.invalidate();
  assert.equal(cache.size(), 0);
});

test("Data Runtime cache 支持按业务边界精确失效", () => {
  const cache = new DataRuntimeCache<number>();
  cache.set("owner:o1|scope:owner:o1|source:project|after:0|limit:500", "r1", 1);
  cache.set("owner:o1|scope:owner:o1|source:file|after:0|limit:500", "r1", 2);
  cache.set("owner:o2|scope:owner:o2|source:project|after:0|limit:500", "r1", 3);
  const removed = cache.invalidateWhere((key) => key.includes("owner:o1|") && key.includes("|source:project|"));
  assert.equal(removed, 1);
  assert.equal(cache.size(), 2);
});
