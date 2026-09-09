import { strict as assert } from "node:assert";
import test from "node:test";
import { buildDocuments, textVersion } from "../src/adapters/base.ts";
import { calendarAdapter } from "../src/adapters/calendar.ts";
import { canvasAdapter } from "../src/adapters/canvas.ts";
import { conversationAdapter } from "../src/adapters/conversations.ts";
import { fileAdapter } from "../src/adapters/files.ts";
import { noteAdapter } from "../src/adapters/note.ts";
import { scheduledTaskAdapter } from "../src/adapters/scheduled-tasks.ts";
import { buildSourceDocuments } from "../src/index-builder.ts";

const ownerScope = { scope_type: "owner", scope_id: "owner-1" };

test("版本计算与 Python text_version 逐位一致（冻结值）", () => {
  assert.equal(textVersion("缓存", "1", "2"), "ad215db968f57716");
  assert.equal(textVersion("", ""), textVersion("", ""));
});

test("file 适配器输出「文件/类型/空间/阶段」头部与五字段元数据", () => {
  const [document] = fileAdapter.toDocuments([{
    id: 7, title: "方案.md", ext: "md", space: "项目A", stage_name: "评审",
    content: "这是文件正文", version_parts: [7, "v3", "2026-09-09T00:00:00"],
    updated_at: "2026-09-09T00:00:00", scope: ownerScope,
  }]);
  assert.equal(document.id, "file:file:7:0");
  assert.equal(document.parent_id, "file:7");
  const fileBody = "文件：方案.md\n类型：md\n空间：项目A\n阶段：评审\n这是文件正文";
  assert.equal(document.content, fileBody);
  assert.equal(document.summary, fileBody.slice(0, 240));
  assert.equal(document.text, ["方案.md", fileBody.slice(0, 240), fileBody].join("\n"));
  assert.deepEqual(document.metadata, {
    file_id: "7", mime_type: "", project_id: "", folder_id: "", space: "项目A",
  });
  assert.equal(document.document_version, textVersion(
    "文件：方案.md\n类型：md\n空间：项目A\n阶段：评审\n这是文件正文", "7", "v3", "2026-09-09T00:00:00"));
  // 空头部字段整行省略；缺正文时只剩元数据索引行。
  const [minimal] = fileAdapter.toDocuments([{
    id: 8, title: "零", version_parts: ["8"], scope: ownerScope,
  }]);
  assert.equal(minimal.content, "文件：零");
  assert.equal(minimal.text, ["零", "文件：零", "文件：零"].join("\n"));
  assert.equal(minimal.metadata.space, "");
});

test("文件按 1000 字符分块、150 字符 overlap，并按码点计数", () => {
  // 文件来源的元数据头部先独立成块，正文按统一的 1000 字符窗口切分。
  const long = "\u5b57".repeat(1000) + "\u{1F600}".repeat(40);
  const documents = fileAdapter.toDocuments([{
    id: 31, title: "长表情.md", content: long, version_parts: ["31"], scope: ownerScope,
  }]);
  assert.equal(documents.length, 3);
  assert.equal(documents[0].content, "文件：长表情.md");
  assert.equal(Array.from(documents[1].content).length, 1000);
  assert.equal(Array.from(documents[2].content).length, 190);
  assert.equal(
    Array.from(documents[2].content).slice(0, 150).join(""),
    Array.from(documents[1].content).slice(-150).join(""),
  );
  assert.ok(documents.every((document) => document.chunk_count === 3));
});

test("note 适配器空标题回落「便签」，content_plain 优先", () => {
  const [document] = noteAdapter.toDocuments([{
    id: 3, title: "", content_plain: "纯文本", content_md: "**md**", kind: "note",
    version_parts: [3, "v1", "hash"], scope: ownerScope,
  }]);
  assert.equal(document.title, "便签");
  // Python 方言：空标题行被 filter(None) 去掉，「便签」只落在 title 字段。
  assert.equal(document.content, "纯文本");
  assert.equal(document.text, ["便签", "纯文本", "纯文本"].join("\n"));
  assert.deepEqual(document.metadata, { node_id: "3", kind: "note" });
});

test("calendar 适配器无时间回落「全天」，空描述整行省略", () => {
  const [document] = calendarAdapter.toDocuments([{
    id: 9, title: "发布会", date: "2026-09-10", time: "", description: "",
    version_parts: [9, "v1", "2026-09-10", ""], scope: ownerScope,
  }]);
  const eventBody = "活动：发布会\n日期：2026-09-10\n时间：全天";
  assert.equal(document.content, eventBody);
  assert.equal(document.text, ["发布会", eventBody, eventBody].join("\n"));
  assert.deepEqual(document.metadata, { event_id: "9", project_id: "" });
});

test("scheduled_task 适配器固定四行结构且空 payload 保留换行", () => {
  const [document] = scheduledTaskAdapter.toDocuments([{
    id: 5, name: "日报", cron: "0 9 * * *", enabled: false,
    version_parts: [5, "2026-09-09T00:00:00", "0 9 * * *", ""], scope: ownerScope,
  }]);
  // Python 方言：_documents 对全文 strip，尾部空 payload 换行不保留。
  const taskBody = "定时任务：日报\n计划：0 9 * * *\n状态：停用";
  assert.equal(document.content, taskBody);
  assert.equal(document.text, ["日报", taskBody, taskBody].join("\n"));
  assert.deepEqual(document.metadata, { task_id: "5", enabled: false });
});

test("canvas 适配器以 id 为稳定 source_id，关系行带「关系：」前缀", () => {
  const [document] = canvasAdapter.toDocuments([{
    id: 21, canvas_id: 2, canvas_title: "发布规划", node_id: 9, node_title: "接口",
    node_type: "canvas_note", content: "接口说明", group_path: "后端",
    relation_summary: "接口 → 测试", project_id: 4,
    version_parts: [21, "2026-09-09T00:00:00", "v2"], updated_at: "2026-09-09T00:00:00",
    scope: ownerScope,
  }]);
  assert.equal(document.parent_id, "canvas:21");
  const canvasBody = "画布：发布规划\n节点：接口\n类型：canvas_note\n分组：后端\n关系：接口 → 测试\n接口说明";
  assert.equal(document.content, canvasBody);
  assert.equal(document.text,
    ["发布规划 · 接口", canvasBody, canvasBody].join("\n"));
  assert.equal(document.title, "发布规划 · 接口");
  assert.deepEqual(document.metadata, {
    canvas_id: "2", node_id: "9", node_type: "canvas_note", group_path: "后端",
    project_id: "4", relation_summary: "接口 → 测试",
  });
});

test("conversation 适配器输出摘要与消息两种文档，元数据含会话事实", () => {
  const documents = conversationAdapter.toDocuments([
    {
      kind: "summary" as const, id: "1:summary", session_id: 1, summary: "讨论了部署", title: "部署会话",
      session_source: "qq", session_updated_at: "2026-09-09T01:00:00",
      version_parts: [1, "2026-09-09T01:00:00", "讨论了部署"],
      updated_at: "2026-09-09T01:00:00", scope: ownerScope,
    },
    {
      kind: "message" as const, id: 12, session_id: 1, role: "user",
      content: "怎么部署", title: "部署会话", session_source: "qq",
      context_before: "user：之前的部署问题",
      context_after: "assistant：可以先检查配置",
      session_updated_at: "2026-09-09T01:00:00",
      version_parts: [12, "2026-09-09T00:30:00", "怎么部署"],
      updated_at: "2026-09-09T00:30:00", scope: ownerScope,
    },
  ]);
  assert.equal(documents.length, 2);
  assert.equal(documents[0].id, "conversation:conversation:1:summary:0");
  assert.equal(documents[0].parent_id, "conversation:1:summary");
  assert.equal(documents[0].content, "会话摘要：讨论了部署");
  assert.equal(documents[0].text, ["部署会话", "会话摘要：讨论了部署", "会话摘要：讨论了部署"].join("\n"));
  assert.equal(documents[0].ranking_text, "会话摘要：讨论了部署");
  assert.deepEqual(documents[0].metadata, {
    session_id: "1", kind: "summary", session_source: "qq",
    session_updated_at: "2026-09-09T01:00:00",
  });
  assert.equal(documents[1].id, "conversation:conversation:12:0");
  assert.equal(documents[1].content, "user：怎么部署");
  assert.equal(documents[1].summary, "");
  assert.equal(documents[1].text, ["部署会话", "user：怎么部署"].join("\n"));
  assert.equal(documents[1].ranking_text, "user：怎么部署");
  assert.equal(documents[1].context_text,
    ["user：之前的部署问题", "user：怎么部署", "assistant：可以先检查配置"].join("\n"));
  assert.deepEqual(documents[1].metadata, {
    session_id: "1", kind: "message", session_source: "qq",
    session_updated_at: "2026-09-09T01:00:00", message_id: "12", role: "user",
    context_before: "user：之前的部署问题", context_after: "assistant：可以先检查配置",
    context_current: "user：怎么部署",
  });
});

test("统一入口按来源分发，文件长文按 1000 字符分块", () => {
  const documents = buildSourceDocuments({
    files: [{ id: 1, title: "长文.txt", content: "字".repeat(3000),
              version_parts: [1], scope: ownerScope }],
    note: [{ id: 2, title: "便签", content_plain: "短文", kind: "note", version_parts: [2], scope: ownerScope }],
  });
  assert.ok(documents.every((document) => document.source_type !== undefined));
  const fileChunks = documents.filter((document) => document.source_type === "file");
  assert.ok(fileChunks.length >= 3);
  assert.equal(Array.from(fileChunks[1].content).length, 1000);
  assert.equal(
    Array.from(fileChunks[2].content).slice(0, 150).join(""),
    Array.from(fileChunks[1].content).slice(-150).join(""),
  );
  assert.ok(fileChunks.every((chunk) => chunk.chunk_count === fileChunks[0].chunk_count));
  const noteDocuments = documents.filter((document) => document.source_type === "note");
  assert.equal(noteDocuments.length, 1);

  // 所有未显式覆盖参数的来源都走同一套 1000/150 默认契约。
  const genericDocuments = buildDocuments({
    id: "knowledge-1", source_type: "knowledge", title: "知识", content: "字".repeat(1200),
    document_version: "v1", scope: ownerScope,
  });
  assert.equal(genericDocuments.length, 2);
  assert.equal(Array.from(genericDocuments[0].content).length, 1000);
  assert.equal(
    Array.from(genericDocuments[1].content).slice(0, 150).join(""),
    Array.from(genericDocuments[0].content).slice(-150).join(""),
  );
});
