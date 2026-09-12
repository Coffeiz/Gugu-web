import assert from "node:assert/strict";
import test from "node:test";
import { DataRuntime } from "../src/runtime.ts";
import { DataRuntimeError } from "../src/contracts.ts";

function fakeSql(rows: unknown[] = []) {
  let calls = 0;
  const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    calls += 1;
    if (String(strings[0]).includes("SELECT")) return Promise.resolve(rows);
    return Promise.resolve([]);
  }) as never;
  return { sql, calls: () => calls };
}

test("Data Runtime 来源读取按 owner/scope/source/revision 命中缓存", async () => {
  const fake = fakeSql([{
    id: 7,
    name: "测试项目",
    status: "pending",
    progress: 0,
    version: 1,
    updated_at: "2026-08-28T00:00:00.000Z",
  }]);
  const runtime = new DataRuntime(fake.sql);
  const first = await runtime.loadRagSourcesCached({ ownerId: "owner-1" }, "project", "r1");
  const second = await runtime.loadRagSourcesCached({ ownerId: "owner-1" }, "project", "r1");
  const changed = await runtime.loadRagSourcesCached({ ownerId: "owner-1" }, "project", "r2");
  assert.equal(first.cache.reason, "miss");
  assert.equal(second.cache.hit, true);
  assert.equal(changed.cache.reason, "revision-changed");
  assert.equal(fake.calls(), 2);
});

test("Data Runtime 业务失效事件只清理对应 owner 和来源", async () => {
  const fake = fakeSql([{
    id: 7,
    name: "测试项目",
    status: "pending",
    progress: 0,
    version: 1,
    updated_at: "2026-08-28T00:00:00.000Z",
  }]);
  const runtime = new DataRuntime(fake.sql);
  await runtime.loadRagSourcesCached({ ownerId: "owner-1" }, "project", "r1");
  await runtime.loadRagSourcesCached({ ownerId: "owner-1" }, "project", "r1", { afterId: 7 });
  await runtime.loadRagSourcesCached({ ownerId: "owner-2" }, "project", "r1");
  assert.equal(runtime.invalidateForEvent({
    ownerId: "owner-1",
    resource: "project",
    operation: "delete",
  }), 2);
  assert.equal(runtime.cacheSize(), 1);
});

test("Data Runtime 把数据库异常转换为结构化错误并拒绝关闭后的读取", async () => {
  const sql = Object.assign(
    (..._args: unknown[]) => Promise.reject(new Error("数据库不可用")),
    { end: async () => undefined },
  ) as never;
  const runtime = new DataRuntime(sql);
  await assert.rejects(
    () => runtime.loadProjects({ ownerId: "owner-1" }),
    (error: unknown) => error instanceof DataRuntimeError && error.code === "database_unavailable",
  );
  await runtime.close();
  await assert.rejects(
    () => runtime.loadProjects({ ownerId: "owner-1" }),
    (error: unknown) => error instanceof DataRuntimeError && error.code === "database_unavailable",
  );
});

test("Data Runtime 拒绝非法分页游标", async () => {
  const fake = fakeSql();
  const runtime = new DataRuntime(fake.sql);
  await assert.rejects(
    () => runtime.loadProjects({ ownerId: "owner-1" }, { afterId: -1 }),
    (error: unknown) => error instanceof DataRuntimeError && error.code === "invalid_cursor",
  );
});

test("Data Runtime 读取 Knowledge 和 Canvas 时保留 owner 边界", async () => {
  const sql = ((strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("knowledge_index_entries")) return Promise.resolve([{
      id: 12, title: "知识", summary: "摘要", content: "正文", document_version: "v1",
      source_type: "knowledge", scope_type: "owner", scope_id: "owner-1", metadata_json: {},
    }]);
    return Promise.resolve([{
      id: 8, canvas_id: 2, node_id: 3, data_json: '{"group_path":"A"}',
      canvas_title: "画布", node_title: "便签", node_type: "note", content_plain: "内容",
      node_version: 1, updated_at: "2026-08-28T00:00:00.000Z", project_id: null,
    }]);
  }) as never;
  const runtime = new DataRuntime(sql);
  const knowledge = await runtime.loadKnowledge({ ownerId: "owner-1" });
  const canvas = await runtime.loadCanvas({ ownerId: "owner-1" });
  assert.equal(knowledge.records[0]?.content, "正文");
  assert.equal(canvas.records[0]?.title, "画布 · 便签");
});

test("Data Runtime conversation 读取相邻消息上下文但保留当前消息正文", async () => {
  const runtime = new DataRuntime((() => Promise.resolve([{
    message_id: 12,
    session_id: 3,
    role: "user",
    content: "当前问题",
    title: "测试会话",
    summary: "",
    created_at: "2026-09-09T00:00:00.000Z",
    context_before: "assistant：上一条回答",
    context_after: "assistant：下一条回答",
  }])) as never);

  const result = await runtime.loadConversationMessages({ ownerId: "owner-1" });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]?.content, "当前问题");
  assert.equal(result.records[0]?.context_before, "assistant：上一条回答");
  assert.equal(result.records[0]?.context_after, "assistant：下一条回答");
});

test("Data Runtime 的 Memory 读取只通过显式 StorageReader", async () => {
  const runtime = new DataRuntime((() => Promise.resolve([])) as never);
  const seen: string[] = [];
  const result = await runtime.loadMemory({ ownerId: "owner-1" }, {
    async readText({ ownerId, key }) {
      assert.equal(ownerId, "owner-1");
      seen.push(key);
      return key.endsWith("memory.md") ? "长期记忆" : null;
    },
  });
  assert.deepEqual(seen, [
    "owner-1/.agent/profile.json", "owner-1/.agent/pattern.json",
    "owner-1/.agent/summary.json", "owner-1/.agent/daily.md", "owner-1/.agent/memory.md",
  ]);
  assert.equal(result.records[0]?.content, "长期记忆");
});

test("Data Runtime 在同一数据库快照装载 RAG 文档和 revision", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const indexedAt = new Date("2026-09-12T08:00:00.000Z");
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join("?").replace(/\s+/g, " "), values });
    return Promise.resolve([
      {
        source_type: "knowledge", max_indexed_at: indexedAt,
        source_id: "kb-7", scope_type: "owner", scope_id: "owner-1",
        document_id: "7", parent_document_id: "7", document_version: "v2",
        chunk_index: 1, chunk_count: 2, title: "知识标题", summary: "知识摘要",
        content: "知识正文", metadata_json: { confidence: 0.8 },
        source_updated_at: indexedAt,
      },
      {
        source_type: "knowledge", max_indexed_at: indexedAt,
        source_id: "kb-7", scope_type: "owner", scope_id: "owner-1",
        document_id: "7", parent_document_id: "7", document_version: "v2",
        chunk_index: 0, chunk_count: 2, title: "知识标题", summary: "知识摘要",
        content: "另一个知识块", metadata_json: {}, source_updated_at: indexedAt,
      },
      {
        source_type: "conversation", max_indexed_at: "2026-09-12T08:30:00.000Z",
        source_id: "message-12", scope_type: "owner", scope_id: "owner-1",
        document_id: "conversation:12", parent_document_id: "conversation:12",
        document_version: "12", chunk_index: 0, chunk_count: 1,
        title: "会话标题", summary: "", content: "当前问题",
        metadata_json: {
          kind: "message", context_before: "assistant：前文",
          context_current: "user：当前问题", context_after: "assistant：后文",
        }, source_updated_at: indexedAt,
      },
      {
        source_type: "memory", max_indexed_at: indexedAt,
        source_id: "memory", scope_type: "owner", scope_id: "owner-1",
        document_id: "memory:memory:1", parent_document_id: "memory:1",
        document_version: "v1", chunk_index: 0, chunk_count: 1,
        title: "长期记忆", summary: "", content: "记忆内容",
        metadata_json: {}, source_updated_at: indexedAt,
      },
    ]);
  }) as never;
  const runtime = new DataRuntime(sql);

  const result = await runtime.loadRagIndex({ ownerId: "owner-1" });

  assert.equal(queries.length, 1);
  assert.match(queries[0]!.text, /MAX\(indexed_at\) OVER \(PARTITION BY source_type\)/);
  assert.match(queries[0]!.text, /owner_user_id = \?/);
  assert.match(queries[0]!.text, /deleted_at IS NULL/);
  assert.deepEqual(queries[0]!.values, ["owner-1"]);
  assert.equal(
    result.revision,
    "ts-jieba-words-v3:rag-projection-v3:conversation:2026-09-12T08:30:00.000Z;knowledge:2026-09-12T08:00:00.000Z;memory:2026-09-12T08:00:00.000Z",
  );
  assert.equal(result.snapshot.documents.length, 4);
  assert.equal(result.snapshot.documents[0]?.id, "knowledge:7:1");
  assert.equal(result.snapshot.documents[0]?.text, "知识标题\n知识摘要\n知识正文");
  assert.equal(result.snapshot.documents[2]?.ranking_text, "当前问题");
  assert.equal(
    result.snapshot.documents[2]?.context_text,
    "assistant：前文\nuser：当前问题\nassistant：后文",
  );
  assert.deepEqual(Object.keys(result.snapshot), ["documents"]);
  assert.deepEqual(result.probe.counts, { database_rows: 4, documents: 4 });
  assert.deepEqual(Object.keys(result.probe.stage_ms).sort(), [
    "database_query", "document_projection", "load_rag_index_total", "revision_projection",
  ]);
  assert.equal(JSON.stringify(result.probe).includes("知识正文"), false);
});

test("Data Runtime 空索引返回 null revision 且不回传正文", async () => {
  const runtime = new DataRuntime((() => Promise.resolve([])) as never);
  const result = await runtime.loadRagIndex({ ownerId: "owner-1" });
  assert.equal(result.revision, null);
  assert.deepEqual(result.snapshot, { documents: [] });
  assert.deepEqual(result.probe.counts, { database_rows: 0, documents: 0 });
  assert.deepEqual(Object.keys(result.probe.stage_ms).sort(), [
    "database_query", "document_projection", "load_rag_index_total", "revision_projection",
  ]);
});
