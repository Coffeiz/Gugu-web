import { strict as assert } from "node:assert";
import test from "node:test";
import { buildSourceDocuments } from "../src/index-builder.ts";

const ownerScope = { scope_type: "owner", scope_id: "owner-1" };

test("文件适配器输出稳定 chunk，并且不写入内部存储路径", () => {
  const [document] = buildSourceDocuments({
    files: [{
      id: 7, display_name: "方案.md", ext: "md", relative_path: "项目/方案.md",
      content: "这是文件正文", document_version: "v1", scope: ownerScope,
    }],
  });
  assert.equal(document.source_type, "file");
  assert.equal(document.parent_id, "file:7");
  assert.equal(document.chunk_index, 0);
  assert.match(document.text, /项目\/方案\.md/);
  assert.equal(document.metadata?.storage_path, undefined);
});

test("来源适配器接受数值 0 作为合法标识", () => {
  const [document] = buildSourceDocuments({
    files: [{
      id: 0, display_name: "零号文件.md", content: "正文", document_version: "v1", scope: ownerScope,
    }],
  });
  assert.equal(document.id, "file:0:0");
});

test("画布适配器保留节点和关系引用，但不把普通时间流笔记混入", () => {
  const [document] = buildSourceDocuments({
    canvas: [{
      canvas_id: 2, node_id: 9, canvas_title: "发布规划", node_title: "接口",
      node_type: "canvas_note", group_path: "后端", relation_summary: "连接到测试",
      content: "接口说明", document_version: "v3", scope: ownerScope,
    }],
  });
  assert.equal(document.source_type, "canvas");
  assert.equal(document.metadata?.canvas_id, "2");
  assert.equal(document.metadata?.node_id, "9");
  assert.match(document.text, /连接到测试/);
  assert.doesNotMatch(document.text, /时间流/);
});

test("对话适配器只接受有 scope 的稳定消息切片", () => {
  const documents = buildSourceDocuments({
    conversations: [
      {
        session_id: 1, message_id: 2, title: "测试", role: "user", content: "保留的片段",
        document_version: "m2", scope: ownerScope,
      },
      {
        session_id: 1, message_id: 3, title: "测试", role: "assistant", content: "",
        document_version: "m3", scope: ownerScope,
      },
      {
        session_id: 1, message_id: 4, title: "测试", role: "assistant", content: "不应进入",
        document_version: "m4", scope: { scope_type: "", scope_id: "" },
      },
    ],
  });
  assert.equal(documents.length, 1);
  assert.equal(documents[0].metadata?.message_id, "2");
  assert.equal(documents[0].metadata?.role, "user");
});
