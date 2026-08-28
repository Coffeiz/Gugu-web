import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import test from "node:test";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { rankCandidates } from "../src/service.ts";

const workerDir = resolve(import.meta.dirname, "..");

test("RAG worker 遵守 JSONL ping 与 replace/search contract", async (t) => {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], { cwd: workerDir });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const pending: Array<(value: string) => void> = [];
  const received: string[] = [];
  lines.on("line", (line) => {
    const waiter = pending.shift();
    if (waiter) waiter(line);
    else received.push(line);
  });
  const readResponse = async (): Promise<Record<string, unknown>> => {
    const line = received.shift() ?? await new Promise<string>((resolveLine) => pending.push(resolveLine));
    return JSON.parse(line) as Record<string, unknown>;
  };
  child.stdin.write('{"op":"ping"}\n');
  assert.equal((await readResponse()).status, "ok");
  child.stdin.write(JSON.stringify({ op: "replace", revision: "r1", documents: [{ id: "d1", text: "画布里的麦子", source_type: "canvas", scope_type: "owner", scope_id: "o1", document_version: "1" }] }) + "\n");
  assert.equal((await readResponse()).revision, "r1");
  child.stdin.write('{"op":"search","revision":"r1","query":"麦子","limit":5}\n');
  const result = await readResponse();
  assert.equal(result.status, "ok");
  assert.equal((result.results as Array<Record<string, unknown>>)[0].id, "d1");
  assert.equal((result.diagnostics as Record<string, unknown>).candidate_count, 1);
  child.stdin.end();
  await once(child, "close");
});

test("RAG worker 的统一 builder 可构建所有通用 source record", async (t) => {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], { cwd: workerDir });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const pending: Array<(value: string) => void> = [];
  const received: string[] = [];
  lines.on("line", (line) => {
    const waiter = pending.shift();
    if (waiter) waiter(line); else received.push(line);
  });
  const readResponse = async (): Promise<Record<string, unknown>> => {
    const line = received.shift() ?? await new Promise<string>((resolveLine) => pending.push(resolveLine));
    return JSON.parse(line) as Record<string, unknown>;
  };
  child.stdin.write(JSON.stringify({ op: "build_documents", batch: {
    memory: [{ id: "m1", source_type: "memory", title: "记忆", content: "稳定记忆", document_version: "v1", scope: { scope_type: "owner", scope_id: "o1" } }],
    knowledge: [{ id: "k1", source_type: "knowledge", title: "知识", content: "稳定知识", document_version: "v1", scope: { scope_type: "owner", scope_id: "o1" } }],
  } }) + "\n");
  const result = await readResponse();
  assert.equal(result.status, "ok");
  assert.equal(result.document_count, 2);
  assert.deepEqual((result.documents as Array<Record<string, unknown>>).map((item) => item.id), ["memory:m1:0", "knowledge:k1:0"]);
  child.stdin.end();
  await once(child, "close");
});

test("RAG worker 可在一次协议请求内构建并更新索引", async (t) => {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], { cwd: workerDir });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const pending: Array<(value: string) => void> = [];
  const received: string[] = [];
  lines.on("line", (line) => {
    const waiter = pending.shift();
    if (waiter) waiter(line); else received.push(line);
  });
  const readResponse = async (): Promise<Record<string, unknown>> => {
    const line = received.shift() ?? await new Promise<string>((resolveLine) => pending.push(resolveLine));
    return JSON.parse(line) as Record<string, unknown>;
  };
  child.stdin.write(JSON.stringify({ op: "build_and_index", revision: "r1", batch: {
    project: [{ id: "p1", source_type: "project", title: "项目", content: "项目缓存", document_version: "v1", scope: { scope_type: "owner", scope_id: "o1" } }],
  } }) + "\n");
  const result = await readResponse();
  assert.equal(result.status, "ok");
  assert.equal(result.revision, "r1");
  assert.equal(result.document_count, 1);
  assert.match(String(result.input_digest), /^[0-9a-f]{16}$/);
  child.stdin.write('{"op":"ping"}\n');
  const ping = await readResponse();
  assert.equal(ping.revision, "r1");
  assert.equal(ping.document_count, 1);
  child.stdin.end();
  await once(child, "close");
});

test("RAG worker 在截断前应用 source 与 scope 过滤", async (t) => {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], { cwd: workerDir });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const pending: Array<(value: string) => void> = [];
  const received: string[] = [];
  lines.on("line", (line) => {
    const waiter = pending.shift();
    if (waiter) waiter(line); else received.push(line);
  });
  const readResponse = async (): Promise<Record<string, unknown>> => {
    const line = received.shift() ?? await new Promise<string>((resolveLine) => pending.push(resolveLine));
    return JSON.parse(line) as Record<string, unknown>;
  };
  const documents = Array.from({ length: 10 }, (_, index) => ({
    id: `wrong-${index}`, text: "麦子 麦子 麦子 麦子", source_type: "memory",
    scope_type: "group", scope_id: "other", document_version: "1",
  }));
  documents.push({ id: "current", text: "麦子", source_type: "knowledge", scope_type: "owner", scope_id: "me", document_version: "1" });
  child.stdin.write(JSON.stringify({ op: "replace", revision: "r1", documents }) + "\n");
  assert.equal((await readResponse()).revision, "r1");
  child.stdin.write(JSON.stringify({
    op: "search", revision: "r1", query: "麦子", limit: 1,
    source_types: ["knowledge"], scope: { scope_type: "owner", scope_id: "me" },
  }) + "\n");
  const result = await readResponse();
  assert.equal((result.results as Array<Record<string, unknown>>)[0].id, "current");
  const diagnostics = result.diagnostics as Record<string, unknown>;
  assert.equal(diagnostics.candidate_count, 11);
  assert.equal(diagnostics.eligible_count, 1);
  assert.equal(diagnostics.filtered_count, 10);
  assert.equal(diagnostics.source_filter_applied, true);
  assert.equal(diagnostics.scope_filter_applied, true);
  child.stdin.end();
  await once(child, "close");
});

test("RAG worker 使用 metadata 过滤 project/folder scope", async (t) => {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], { cwd: workerDir });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const pending: Array<(value: string) => void> = [];
  const received: string[] = [];
  lines.on("line", (line) => {
    const waiter = pending.shift();
    if (waiter) waiter(line); else received.push(line);
  });
  const readResponse = async (): Promise<Record<string, unknown>> => {
    const line = received.shift() ?? await new Promise<string>((resolveLine) => pending.push(resolveLine));
    return JSON.parse(line) as Record<string, unknown>;
  };
  child.stdin.write(JSON.stringify({
    op: "replace", revision: "r1", documents: [
      { id: "p1", text: "项目范围正文", source_type: "file", scope_type: "owner", scope_id: "owner-1", document_version: "1", metadata: { project_id: "project-1", folder_id: "folder-1" } },
      { id: "p2", text: "另一个项目正文", source_type: "file", scope_type: "owner", scope_id: "owner-1", document_version: "1", metadata: { project_id: "project-2", folder_id: "folder-2" } },
    ],
  }) + "\n");
  assert.equal((await readResponse()).revision, "r1");
  child.stdin.write(JSON.stringify({
    op: "search", revision: "r1", query: "正文", limit: 5,
    source_types: ["file"], scope: { scope_type: "folder", scope_id: "folder-1" },
  }) + "\n");
  const result = await readResponse();
  assert.deepEqual((result.results as Array<Record<string, unknown>>).map((item) => item.id), ["p1"]);
  child.stdin.end();
  await once(child, "close");
});

test("RAG worker unified_search 执行正文去重、来源上限和字符预算", async (t) => {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], { cwd: workerDir });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const pending: Array<(value: string) => void> = [];
  const received: string[] = [];
  lines.on("line", (line) => {
    const waiter = pending.shift();
    if (waiter) waiter(line); else received.push(line);
  });
  const readResponse = async (): Promise<Record<string, unknown>> => {
    const line = received.shift() ?? await new Promise<string>((resolveLine) => pending.push(resolveLine));
    return JSON.parse(line) as Record<string, unknown>;
  };
  const documents = [
    { id: "a", text: "统一召回的第一段内容", source_type: "file", scope_type: "owner", scope_id: "me", document_version: "1", parent_id: "file:1" },
    { id: "b", text: "统一召回的第一段内容", source_type: "canvas", scope_type: "owner", scope_id: "me", document_version: "1", parent_id: "canvas:1" },
    { id: "c", text: "统一召回的第二段内容", source_type: "file", scope_type: "owner", scope_id: "me", document_version: "1", parent_id: "file:2" },
  ];
  child.stdin.write(JSON.stringify({ op: "replace", revision: "r1", documents }) + "\n");
  assert.equal((await readResponse()).revision, "r1");
  child.stdin.write(JSON.stringify({ op: "unified_search", revision: "r1", query: "统一召回", limit: 5, max_chars: 18 }) + "\n");
  const result = await readResponse();
  assert.equal(result.status, "ok");
  assert.equal((result.results as Array<Record<string, unknown>>).length, 2);
  assert.equal((result.diagnostics as Record<string, unknown>).rejected_duplicate, 1);
  assert.equal((result.diagnostics as Record<string, unknown>).output_chars, 18);
  child.stdin.end();
  await once(child, "close");
});

test("TS 完整候选流水线与 Python 评分契约保持一致", () => {
  const output = rankCandidates("缓存", [
    {
      id: "file:1", source_type: "file", raw_score: 10, rank: 1,
      document: { id: "file:1", text: "缓存索引说明", source_type: "file", scope_type: "owner", scope_id: "owner-1", document_version: "1", parent_id: "file:1" },
    },
    {
      id: "file:2", source_type: "file", raw_score: 5, rank: 2,
      document: { id: "file:2", text: "完全不同的内容", source_type: "file", scope_type: "owner", scope_id: "owner-1", document_version: "1", parent_id: "file:2" },
    },
    {
      id: "memory:1", source_type: "memory", raw_score: 1, rank: 1,
      document: { id: "memory:1", text: "缓存使用规则", source_type: "memory", scope_type: "owner", scope_id: "owner-1", document_version: "1", parent_id: "memory:1" },
    },
  ], { limit: 5, maxChars: 1000 });

  assert.deepEqual(output.results.map((item) => item.id), ["file:1", "memory:1"]);
  assert.equal(output.diagnostics.rejected_low_score, 1);
  assert.equal(output.diagnostics.scoring_version, "confidence-v1");
  assert.equal(output.diagnostics.output_chars, 12);
});

test("rank_candidates 在评分前排除已注入的历史内容", () => {
  const historicalText = "历史知识内容";
  const output = rankCandidates("知识", [
    {
      id: "history", source_type: "knowledge", raw_score: 10, rank: 1,
      document: { id: "history", text: historicalText, source_type: "knowledge", scope_type: "owner", scope_id: "owner-1", document_version: "1" },
    },
    {
      id: "fresh", source_type: "knowledge", raw_score: 5, rank: 2,
      document: { id: "fresh", text: "新的知识内容", source_type: "knowledge", scope_type: "owner", scope_id: "owner-1", document_version: "1" },
    },
  ], {
    limit: 5,
    maxChars: 1000,
    excludeContentHashes: [
      createHash("sha256").update(historicalText).digest("hex"),
    ],
  });

  assert.deepEqual(output.results.map((item) => item.id), ["fresh"]);
});

test("rank_candidates 返回跨来源 citation 和按来源诊断", () => {
  const output = rankCandidates("共同", [
    {
      id: "file:1", source_type: "file", raw_score: 2, rank: 1,
      document: { id: "file:1", text: "共同内容", source_type: "file", title: "文件来源", scope_type: "owner", scope_id: "owner-1", document_version: "v1", metadata: { source_id: "file-1" } },
    },
    {
      id: "canvas:1", source_type: "canvas", raw_score: 1, rank: 1,
      document: { id: "canvas:1", text: "共同内容", source_type: "canvas", title: "画布来源", scope_type: "owner", scope_id: "owner-1", document_version: "v1", metadata: { source_id: "canvas-1" } },
    },
  ], { limit: 5, maxChars: 1000 });

  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].citations.length, 2);
  assert.deepEqual(output.results[0].citations.map((item) => item.source_id), ["file-1", "canvas-1"]);
  assert.equal(output.diagnostics.source_diagnostics?.file.candidate_count, 1);
  assert.equal(output.diagnostics.source_diagnostics?.canvas.accepted_count, 0);
});
