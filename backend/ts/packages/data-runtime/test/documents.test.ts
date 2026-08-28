import assert from "node:assert/strict";
import test from "node:test";
import { buildChunks, diffChunks } from "../src/documents.ts";
import type { RagSourceRecord } from "../../contracts/src/rag.ts";

function record(content: string): RagSourceRecord {
  return {
    id: "42",
    source_type: "project",
    scope: { scope_type: "owner", scope_id: "owner-1" },
    title: "测试项目",
    content,
    document_version: "r1",
  };
}

test("Data Runtime chunk 使用稳定 key 并输出 digest", () => {
  const chunks = buildChunks(record("第一段内容\n\n第二段内容"), 5, 0);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].chunk_id, "project:42:0");
  assert.equal(chunks[0].parent_id, "project:42");
  assert.equal(chunks[0].digest.length, 64);
  assert.equal(chunks[0].scope_id, "owner-1");
});

test("Data Runtime diff 只返回变化 chunk 和删除 chunk", () => {
  const previous = buildChunks(record("abcdefghijklmno"), 5, 0);
  const next = buildChunks(record("abcdeXYZ"), 5, 0);
  const patch = diffChunks(previous, next);
  assert.deepEqual(patch.deletes, ["project:42:2"]);
  assert.deepEqual(patch.upserts.map((chunk) => chunk.chunk_id), ["project:42:1"]);
});
