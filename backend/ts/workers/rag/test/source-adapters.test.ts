import { strict as assert } from "node:assert";
import test from "node:test";
import { buildSourceDocuments } from "../src/index-builder.ts";

const ownerScope = { scope_type: "owner", scope_id: "owner-1" };

test("文件适配器输出与 Python 一致的头部行，并且不写入内部存储路径", () => {
  const [document] = buildSourceDocuments({
    files: [{
      id: 7, title: "方案.md", ext: "md", space: "项目A", stage_name: "评审",
      content: "这是文件正文", version_parts: [7, "v1", "2026-09-09T00:00:00"],
      scope: ownerScope,
    }],
  });
  assert.equal(document.source_type, "file");
  assert.equal(document.parent_id, "file:7");
  assert.match(document.content, /^文件：方案\.md/);
  assert.match(document.content, /类型：md/);
  assert.match(document.content, /空间：项目A/);
  assert.match(document.content, /阶段：评审/);
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
