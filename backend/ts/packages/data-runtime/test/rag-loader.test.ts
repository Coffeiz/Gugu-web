import assert from "node:assert/strict";
import test from "node:test";
import { loadMemoryCached, loadRagBatch, loadRagBatchCached } from "../src/rag-loader.ts";

test("Data Runtime RAG loader 按来源生成统一 batch", async () => {
  const runtime = {
    async loadRagSources(_context: unknown, source: string) {
      return { records: [{ id: source, source_type: source }] };
    },
  } as never;
  const batch = await loadRagBatch(runtime, { ownerId: "owner-1" });
  assert.deepEqual(batch, {
    project: [{ id: "project", source_type: "project" }],
    files: [{ id: "file", source_type: "file" }],
    conversations: [{ id: "conversation", source_type: "conversation" }],
    knowledge: [{ id: "knowledge", source_type: "knowledge" }],
    canvas: [{ id: "canvas", source_type: "canvas" }],
  });
});

test("loadRagBatchCached 统一读取新增来源并保留 per-source cache 状态", async () => {
  const runtime = {
    loadRagSourcesCached: async (_context: unknown, source: string, revision: string) => ({
      records: [{ id: source, source_type: source }],
      cache: { hit: source === "knowledge", reason: "hit" as const, key: source, revision },
    }),
  } as never;
  const result = await loadRagBatchCached(runtime, { ownerId: "owner-1" }, "r2");
  assert.equal(result.batch.knowledge?.[0]?.id, "knowledge");
  assert.equal(result.batch.canvas?.[0]?.id, "canvas");
  assert.equal(result.cache.knowledge?.hit, true);
  assert.equal(result.cache.project?.revision, "r2");
});

test("loadMemoryCached 在同一 revision 下复用 StorageReader 结果", async () => {
  let reads = 0;
  const runtime = {
    readCachedWithStatus: async (_key: string, revision: string, loader: () => Promise<{ records: [] }>) => {
      reads += 1;
      return { value: await loader(), hit: reads > 1, reason: "miss" as const };
    },
    loadMemory: async () => ({ records: [] }),
  } as never;
  const storage = { readText: async () => null };
  const first = await loadMemoryCached(runtime, { ownerId: "owner-1" }, storage, "r1");
  const second = await loadMemoryCached(runtime, { ownerId: "owner-1" }, storage, "r1");
  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, true);
  assert.equal(second.cache.revision, "r1");
});
