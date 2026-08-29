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
