import { strict as assert } from "node:assert";
import test from "node:test";
import { buildSourceDocuments } from "../src/index-builder.ts";
import { buildDocuments } from "../src/adapters/base.ts";

const ownerScope = { scope_type: "owner", scope_id: "owner-1" };

test("文件适配器只索引文件名，并且不写入正文或内部存储路径", () => {
  const [document] = buildSourceDocuments({
    files: [{
      id: 7, title: "方案.md", ext: "md", space: "项目A", stage_name: "评审",
      content: "这是文件正文", version_parts: [7, "v1", "2026-09-09T00:00:00"],
      scope: ownerScope,
    }],
  });
  assert.equal(document.source_type, "file");
  assert.equal(document.parent_id, "file:7");
  assert.equal(document.content, "方案.md");
  assert.equal(document.text, "方案.md\n方案.md");
  assert.doesNotMatch(document.content, /这是文件正文/);
  assert.doesNotMatch(document.content, /storage|\/data\//);
  // 检索索引正文 = title\nsummary\ncontent（与 Python _wire_document 一致）。
  assert.match(document.text, /^方案\.md\n/);
  assert.equal(document.metadata?.storage_path, undefined);
});

test("来源适配器接受数值 0 作为合法标识", () => {
  const [document] = buildSourceDocuments({
    files: [{
      id: 0, title: "零号文件.md", content: "正文", version_parts: [0], scope: ownerScope,
    }],
  });
  assert.equal(document.parent_id, "file:0");
  assert.equal(document.id, "file:file:0:0");
});

test("画布适配器以 id 为稳定标识并保留关系引用，不把普通时间流笔记混入", () => {
  const documents = buildSourceDocuments({
    canvas: [{
      id: 21, canvas_id: 2, canvas_title: "发布规划", node_id: 9, node_title: "接口",
      node_type: "canvas_note", content: "接口说明", group_path: "后端",
      relation_summary: "连接到测试", version_parts: [21], scope: ownerScope,
    }],
    note: [{
      id: 31, title: "时间流片段", content_plain: "不应进入画布", kind: "note",
      version_parts: [31], scope: ownerScope,
    }],
  });
  const canvasDocuments = documents.filter((document) => document.source_type === "canvas");
  assert.equal(canvasDocuments.length, 1);
  assert.equal(canvasDocuments[0].parent_id, "canvas:21");
  assert.match(canvasDocuments[0].content, /关系：连接到测试/);
  assert.equal(canvasDocuments[0].metadata?.canvas_id, "2");
  assert.equal(canvasDocuments[0].metadata?.node_id, "9");
  assert.ok(documents.some((document) => document.source_type === "note"));
});

test("对话适配器只接受有 scope 的稳定摘要或消息切片", () => {
  const documents = buildSourceDocuments({
    conversations: [
      {
        kind: "message", id: 2, session_id: 1, role: "user", content: "保留的片段",
        title: "测试", version_parts: [2], scope: ownerScope,
      },
      {
        kind: "message", id: 3, session_id: 1, role: "assistant", content: "",
        title: "测试", version_parts: [3], scope: ownerScope,
      },
      {
        kind: "message", id: 4, session_id: 1, role: "assistant", content: "不应进入",
        title: "测试", version_parts: [4], scope: { scope_type: "", scope_id: "" },
      },
    ],
  });
  assert.equal(documents.length, 1);
  assert.equal(documents[0].metadata?.message_id, "2");
  assert.equal(documents[0].metadata?.role, "user");
  assert.equal(documents[0].metadata?.kind, "message");
});

test("summary 为正文前缀截断时不重复拼进检索文本（记忆注入去重根因）", () => {
  const [memory] = buildDocuments({
    source_type: "memory", id: "daily:0", source_id: "daily",
    title: "近期记忆", summary: "- 2026-09-14 凌晨聊了召回",
    content: "- 2026-09-14 凌晨聊了召回", version_parts: ["daily", "daily:0"],
    document_version: "v1",
    scope: ownerScope,
  });
  // 前缀守卫：summary 与正文相同（截断拷贝）则不再拼接，正文只出现一次。
  assert.equal(memory.text, "近期记忆\n- 2026-09-14 凌晨聊了召回");

  const [knowledge] = buildDocuments({
    source_type: "knowledge", id: "k-1", source_id: "k-1",
    title: "部署规范", summary: "发布时需要读",
    content: "发布前必须跑完 CI 双工作流", version_parts: ["k", "1"],
    document_version: "v1",
    scope: ownerScope,
  });
  // 真实摘要（与正文无前缀关系）照常保留 title/summary/content 三段。
  assert.equal(knowledge.text, "部署规范\n发布时需要读\n发布前必须跑完 CI 双工作流");
});
