import assert from "node:assert/strict";
import test from "node:test";
import { TsRagService, type RagServiceEngine } from "../src/rag-service.ts";
import type { RagResponse, RagSourceBatch } from "../../../packages/contracts/src/rag.ts";

function ok<T extends Record<string, unknown>>(value: T): RagResponse {
  return { status: "ok", version: "test", revision: "r1", ...value } as unknown as RagResponse;
}

test("TS RAG service 在同一 scope/revision 复用索引并把召回交给 worker", async () => {
  let loads = 0;
  const builds: string[] = [];
  const searches: string[] = [];
  const engine: RagServiceEngine = {
    async buildAndIndex(revision: string, _batch: RagSourceBatch) {
      builds.push(revision);
      return ok({ document_count: 1 });
    },
    async unifiedSearch(revision: string, query: string) {
      searches.push(`${revision}:${query}`);
      return ok({ results: [{ id: "memory:m1:0", text: "稳定记忆", source_type: "memory", scope_type: "owner", scope_id: "o1", document_version: "1" }], has_more: false, diagnostics: { candidate_count: 1 } });
    },
  };
  const service = new TsRagService(async () => {
    loads += 1;
    return { memory: [{ id: "m1", source_type: "memory", title: "记忆", content: "稳定记忆", document_version: "1", scope: { scope_type: "owner", scope_id: "o1" } }] };
  }, engine);
  const context = { scopeKey: "owner:o1", revision: "r1" };

  assert.equal((await service.search(context, "记忆")).built, true);
  assert.equal((await service.search(context, "稳定")).built, false);
  assert.equal(loads, 1);
  assert.deepEqual(builds, ["r1"]);
  assert.deepEqual(searches, ["r1:记忆", "r1:稳定"]);

  assert.equal((await service.search({ ...context, revision: "r2" }, "记忆")).built, true);
  assert.equal(loads, 2);
  assert.equal(service.size(), 1);
});

test("TS RAG service 不接受缺少 scope 或 revision 的请求", async () => {
  const engine: RagServiceEngine = {
    async buildAndIndex() { return ok({ document_count: 0 }); },
    async unifiedSearch() { return ok({ results: [], has_more: false, diagnostics: {} }); },
  };
  const service = new TsRagService(async () => ({}), engine);
  await assert.rejects(() => service.search({ scopeKey: "", revision: "r1" }, "x"), /scopeKey/);
  await assert.rejects(() => service.search({ scopeKey: "o1", revision: "" }, "x"), /revision/);
});
