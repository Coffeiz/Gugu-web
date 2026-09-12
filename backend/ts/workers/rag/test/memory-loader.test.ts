import assert from "node:assert/strict";
import test from "node:test";
import type { StorageReader } from "../../../packages/data-runtime/src/contracts.ts";
import { prepareMemory } from "../src/memory-loader.ts";

function storage(files: Record<string, string>): StorageReader {
  return {
    async readText({ key }) {
      return Object.hasOwn(files, key) ? files[key]! : null;
    },
  };
}

const ownerScope = (ownerId: string) => [{ type: "owner" as const, id: ownerId, ownerId }];

test("Memory loader 在 TS 内读取 owner index、刷新 daily 并只接收当前模型向量", async () => {
  const ownerId = "memory-loader-owner-1";
  const parentId = "memory:profile:profile:0";
  const files = {
    [`${ownerId}/.agent/rag/memory-index-v1.json`]: JSON.stringify({ schema_version: 1, documents: [
      {
        document_id: parentId, parent_document_id: parentId, chunk_index: 0, chunk_count: 1,
        source_type: "memory", source_id: "profile", title: "用户画像", summary: "偏好咖啡",
        content: "偏好咖啡", version: "profile-v1",
        scope: { owner_user_id: ownerId, scope_type: "owner", scope_id: "", platform: "", bot_id: "", group_id: "" },
        metadata: {},
      },
      {
        document_id: "leak", parent_document_id: "leak", chunk_index: 0, chunk_count: 1,
        source_type: "memory", source_id: "profile", title: "不应读取", content: "他人正文", version: "v1",
        scope: { owner_user_id: "other-owner", scope_type: "owner", scope_id: "" }, metadata: {},
      },
    ] }),
    [`${ownerId}/.agent/daily.md`]: "## 2026-09-12\n- 今天完成测试\n",
    [`${ownerId}/.agent/memory_vec.json`]: JSON.stringify({
      [`rag:${parentId}:profile-v1:0`]: { t: "provider:model:2", v: [0.25, 0.75] },
      "stale": { t: "old-model", v: [1] },
    }),
  };
  const result = await prepareMemory({
    ownerId, scopes: ownerScope(ownerId), sourceFilter: "all",
    snapshotRevision: "0", snapshotText: "", vectorVersion: "provider:model:2",
  }, {} as never, storage(files));

  assert.equal(result.documents.length, 2);
  assert.deepEqual(result.documents.map((document) => document.source_id), ["profile", "daily"]);
  assert.equal(result.documents[1]?.content, "- 2026-09-12 今天完成测试");
  assert.deepEqual(result.vectors, { [`memory:${parentId}:0`]: [0.25, 0.75] });
  assert.equal(result.probe.counts.base_documents, 2);
  assert.equal(result.probe.counts.selected_documents, 2);
  assert.equal(result.probe.counts.vector_count, 1);
  assert.equal(result.probe.cache.owner_cache_hit, false);
  for (const stage of ["owner_document_read_and_adapt", "source_filter", "scope_filter",
    "snapshot_dedup_filter", "vector_load", "prepare_memory_total"]) {
    assert.ok(result.probe.stage_ms[stage] >= 0, `probe 缺少阶段 ${stage}`);
  }

  const cached = await prepareMemory({
    ownerId, scopes: ownerScope(ownerId), sourceFilter: "all",
    snapshotRevision: "0", snapshotText: "", vectorVersion: "provider:model:2",
  }, {} as never, storage(files));
  assert.equal(cached.probe.cache.owner_cache_hit, true);
  assert.equal(cached.probe.counts.selected_documents, 2);
});

test("Memory loader 不会因现存空 pattern 文件复活旧 facts", async () => {
  const ownerId = "memory-loader-owner-2";
  const result = await prepareMemory({
    ownerId, scopes: ownerScope(ownerId), sourceFilter: "pattern",
    snapshotRevision: "", snapshotText: "", vectorVersion: "",
  }, {} as never, storage({
    [`${ownerId}/.agent/pattern.json`]: "",
    [`${ownerId}/.agent/facts.json`]: JSON.stringify([{ id: "legacy", text: "过期行为模式" }]),
    [`${ownerId}/.agent/facts.md`]: "- 更旧的行为模式",
  }));
  assert.deepEqual(result.documents, []);
});

test("Memory loader 对 scope owner 做独立校验并尊重 tombstone", async () => {
  const ownerId = "memory-loader-owner-3";
  await assert.rejects(() => prepareMemory({
    ownerId,
    scopes: [{ type: "group", id: "g1", ownerId: "different-owner", platform: "qq", botId: "bot", groupId: "g1" }],
    sourceFilter: "all", snapshotRevision: "", snapshotText: "", vectorVersion: "",
  }, {} as never, storage({})), /不匹配的 Memory owner scope/u);

  const requested: string[] = [];
  const runtime = {
    async getMemoryScopeState(_context: unknown, scope: { type: string; id: string }) {
      requested.push(`${scope.type}:${scope.id}`);
      return { revision: "3:updated", tombstoned: true };
    },
  };
  const result = await prepareMemory({
    ownerId,
    scopes: [{ type: "group", id: "group-9", ownerId, platform: "qq", botId: "bot-1", groupId: "group-9" }],
    sourceFilter: "all", snapshotRevision: "", snapshotText: "", vectorVersion: "",
  }, runtime as never, storage({}));
  assert.deepEqual(requested, ["group:group-9"]);
  assert.deepEqual(result.documents, []);
  assert.equal(result.indexSource, "scope-tombstone");
});

test("Memory loader 按已授权 scope 投影群组记忆", async () => {
  const ownerId = "memory-loader-owner-4";
  const prefix = `${ownerId}/.agent/im/qq/bot-1/groups/group-7/`;
  const runtime = {
    async getMemoryScopeState() { return { revision: "4:updated", tombstoned: false }; },
  };
  const result = await prepareMemory({
    ownerId,
    scopes: [{ type: "group", id: "group-7", ownerId, platform: "qq", botId: "bot-1", groupId: "group-7" }],
    sourceFilter: "all", snapshotRevision: "", snapshotText: "", vectorVersion: "",
  }, runtime as never, storage({
    [`${prefix}profile.json`]: JSON.stringify({ text: "群内项目" }),
    [`${prefix}summary.json`]: JSON.stringify({ summary: "每周讨论项目进度" }),
    [`${prefix}daily.md`]: "## 2026-09-12\n- 讨论了发布计划\n",
    [`${prefix}memory.md`]: "长期记录不应越权",
  }));
  // 与既有 Python Memory source filter 保持一致：group summary 不是当前可召回来源。
  assert.deepEqual(result.documents.map((document) => document.source_id), ["profile", "daily", "memory"]);
  for (const document of result.documents) {
    assert.equal(document.scope_type, "group");
    assert.equal(document.scope_id, "group-7");
    assert.equal(document.group_id, "group-7");
  }
  assert.match(result.documents[0]?.content || "", /群内项目/u);
});

test("Memory source filter 与 snapshot 去重在 TS loader 内执行", async () => {
  const ownerId = "memory-loader-owner-5";
  const profile = "项目偏好与发布计划保持同步";
  const result = await prepareMemory({
    ownerId, scopes: ownerScope(ownerId), sourceFilter: "profile",
    snapshotRevision: "", snapshotText: `之前的上下文：${profile}`,
    vectorVersion: "",
  }, {} as never, storage({
    [`${ownerId}/.agent/profile.json`]: JSON.stringify([{ text: profile }]),
    [`${ownerId}/.agent/pattern.json`]: JSON.stringify([{ id: "p1", text: "需要先做计划" }]),
    [`${ownerId}/.agent/daily.md`]: "## 2026-09-12\n- 另一条 daily\n",
  }));
  assert.deepEqual(result.documents, []);
});
