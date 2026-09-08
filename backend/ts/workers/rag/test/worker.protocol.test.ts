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
  // 与 Python _worker_document_key 口径一致：id = source_type:document_id:chunk（document_id 已带一次 source_type 前缀）。
  assert.deepEqual((result.documents as Array<Record<string, unknown>>).map((item) => item.id), ["memory:memory:m1:0", "knowledge:knowledge:k1:0"]);
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
  assert.equal(output.results[0].fused_score, output.results[0].normalized_score);
  assert.equal(output.diagnostics.rejected_low_score, 1);
  assert.equal(output.diagnostics.scoring_version, "confidence-v1");
  assert.equal(output.diagnostics.output_chars, 12);
});

test("主动候选搜索按 Top-K 返回，不受 confidence 阈值过滤", () => {
  const output = rankCandidates("缓存", [
    {
      id: "knowledge:1", source_type: "knowledge", raw_score: 0.01, rank: 1, fused_score: null,
      document: { id: "knowledge:1", text: "缓存相关知识", source_type: "knowledge", scope_type: "owner", scope_id: "owner-1", document_version: "1", metadata: { confidence: "confirmed" } },
    },
  ], { limit: 5, maxChars: 1000, selectionMode: "top_k" });

  assert.equal(output.results.length, 1);
  assert.ok(output.results[0].fused_score > 0);
  assert.equal(output.diagnostics.selection_mode, "top_k");
  assert.equal(output.diagnostics.rejected_low_score, 0);
});

test("主动 Top-K 不再被来源、父文档和相似度配额二次截断", () => {
  const output = rankCandidates("缓存", Array.from({ length: 5 }, (_, index) => ({
    id: `memory:${index}`,
    source_type: "memory",
    raw_score: 10 - index,
    rank: index + 1,
    document: {
      id: `memory:${index}`,
      text: `缓存相关记录 ${index} 的具体内容`,
      source_type: "memory",
      scope_type: "owner",
      scope_id: "owner-1",
      document_version: "1",
      parent_id: "memory:shared-parent",
    },
  })), { limit: 5, maxChars: 1000, selectionMode: "top_k" });

  assert.equal(output.results.length, 5);
  assert.equal(output.diagnostics.rejected_source, 0);
  assert.equal(output.diagnostics.rejected_parent, 0);
  assert.equal(output.diagnostics.rejected_similarity, 0);
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

function spawnWorker(t: import("node:test").TestContext) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], { cwd: workerDir });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const pending: Array<(value: string) => void> = [];
  const received: string[] = [];
  lines.on("line", (line) => {
    const waiter = pending.shift();
    if (waiter) waiter(line); else received.push(line);
  });
  const request = (payload: unknown) => child.stdin.write(JSON.stringify(payload) + "\n");
  const readResponse = async (): Promise<Record<string, unknown>> => {
    const line = received.shift() ?? await new Promise<string>((resolveLine) => pending.push(resolveLine));
    return JSON.parse(line) as Record<string, unknown>;
  };
  return { child, request, readResponse, closed: once(child, "close") };
}

test("RAG worker 的 replace_transient 与持久化索引共存且不落盘", async (t) => {
  const { child, request, readResponse, closed } = spawnWorker(t);
  const files = Array.from({ length: 10 }, (_, index) => ({
    id: `f${index}`, text: "文件缓存正文", source_type: "file",
    scope_type: "owner", scope_id: "o1", document_version: "1",
  }));
  request({ op: "replace", revision: "r1", documents: files });
  assert.equal((await readResponse()).revision, "r1");
  request({ op: "replace_transient", revision: "t1", documents: [
    { id: "m1", text: "记忆快照正文", source_type: "memory",
      scope_type: "owner", scope_id: "o1", document_version: "v1" },
  ] });
  const transient = await readResponse();
  assert.equal(transient.status, "ok");
  assert.equal(transient.revision, "t1");
  assert.equal(transient.document_count, 1);
  // ping 只报持久化索引：瞬态语料不合并、不污染持久化 revision。
  request({ op: "ping" });
  const ping = await readResponse();
  assert.equal(ping.revision, "r1");
  assert.equal(ping.document_count, 10);
  child.stdin.end();
  await closed;
});

test("RAG worker 的 batch_search 按语料槽独立检索并拒绝空瞬态指纹", async (t) => {
  const { child, request, readResponse, closed } = spawnWorker(t);
  request({ op: "replace", revision: "r1", documents: [
    { id: "f1", text: "缓存文件正文", source_type: "file", scope_type: "owner", scope_id: "o1", document_version: "1" },
  ] });
  assert.equal((await readResponse()).revision, "r1");
  request({ op: "replace_transient", revision: "t1", documents: [
    { id: "m1", text: "缓存记忆正文", source_type: "memory", scope_type: "owner", scope_id: "o1", document_version: "v1" },
  ] });
  assert.equal((await readResponse()).revision, "t1");
  // 空瞬态指纹视为语料未装载，必须拒绝。
  request({ op: "batch_search", revision: "r1", query: "缓存", searches: [
    { id: "m", source_types: ["memory"], corpus: "transient", limit: 5 },
  ] });
  const rejected = await readResponse();
  assert.equal(rejected.status, "error");
  assert.equal(rejected.code, "revision_mismatch");
  // 带上指纹后一次批量查询同时取回持久化与瞬态命中。
  request({ op: "batch_search", revision: "r1", transient_revision: "t1", query: "缓存", searches: [
    { id: "f", source_types: ["file"], limit: 5 },
    { id: "m", source_types: ["memory"], corpus: "transient", limit: 5 },
  ] });
  const result = await readResponse();
  assert.equal(result.status, "ok");
  assert.deepEqual(result.document_counts, { file: 1, memory: 1 });
  const batches = result.batches as Array<Record<string, unknown>>;
  assert.deepEqual(batches.map((item) => item.id), ["f", "m"]);
  assert.deepEqual((batches[0].results as Array<Record<string, unknown>>).map((item) => item.id), ["f1"]);
  assert.deepEqual((batches[1].results as Array<Record<string, unknown>>).map((item) => item.id), ["m1"]);
  // 瞬态指纹不一致同样拒绝。
  request({ op: "batch_search", revision: "r1", transient_revision: "t2", query: "缓存", searches: [
    { id: "m", source_types: ["memory"], corpus: "transient", limit: 5 },
  ] });
  assert.equal((await readResponse()).code, "revision_mismatch");
  child.stdin.end();
  await closed;
});

function rankDocument(id: string, sourceType: string, text: string, updatedAt = "") {
  return {
    id, text, source_type: sourceType, scope_type: "owner", scope_id: "o1",
    document_version: "1", parent_id: id, updated_at: updatedAt,
  };
}

test("冻结契约：来源优先级决定入选，最终输出同分按 id 升序（confidence-v1）", () => {
  // fused 分数相同（各来源单候选，组内归一化同为 0.5），文本互不相同避免同文去重。
  const candidates = ["conversation", "canvas", "file", "project", "memory"].map((sourceType) => ({
    id: `c-${sourceType}`,
    source_type: sourceType,
    raw_score: 1,
    rank: 1,
    document: rankDocument(`c-${sourceType}`, sourceType, `共同内容-${sourceType}`),
  }));
  // 冻结行为：SOURCE_PRIORITY 只决定 confidence 入选顺序（memory 最先入选），
  // 最终输出由预算阶段按 fused 降序 + id 升序重排。
  const output = rankCandidates("共同", candidates, { limit: 2, maxChars: 1000 });
  assert.deepEqual(output.results.map((item) => item.id), ["c-memory", "c-project"]);
  const full = rankCandidates("共同", candidates, { limit: 5, maxChars: 1000 });
  assert.deepEqual(
    full.results.map((item) => item.id),
    ["c-canvas", "c-conversation", "c-file", "c-memory", "c-project"],
  );

  // 同来源内 fused 与 updated_at 全同 → 按 id 升序。
  const sameSource = ["b", "a"].map((suffix) => ({
    id: `c-${suffix}`,
    source_type: "file",
    raw_score: 1,
    document: rankDocument(`c-${suffix}`, "file", `同源内容-${suffix}`),
  }));
  const sameOutput = rankCandidates("同源", sameSource, { limit: 5, maxChars: 1000 });
  assert.deepEqual(sameOutput.results.map((item) => item.id), ["c-a", "c-b"]);
});

test("冻结契约：confidence 阈值与 scoring_version 保持 confidence-v1", () => {
  const low = {
    id: "low", source_type: "file", raw_score: 1,
    document: rankDocument("low", "file", "毫不相关的-random-tokens"),
  };
  const output = rankCandidates("缓存", [low], { limit: 5, maxChars: 1000 });
  // match=0 的候选 confidence 被压到 0.35 以下，confidence 模式下全部被拒。
  assert.equal(output.results.length, 0);
  assert.equal(output.diagnostics.scoring_version, "confidence-v1");
  assert.equal(output.diagnostics.threshold, 0.35);
  assert.equal(output.diagnostics.preferred_threshold, 0.55);
  assert.equal(output.diagnostics.selection_mode, "confidence");
  assert.ok(output.diagnostics.rejected_low_score >= 1);
});

test("冻结契约：hybrid_fuse 与 Python hybrid_results 的 RRF 逐位一致", async (t) => {
  const { request, readResponse, closed, child } = spawnWorker(t);
  // 词法名次 a1 b2 c3 d4 e5；向量：a/c 与查询同向（c 同向但模长不同），
  // b 正交（0.0）、d 维度不匹配（0.0 但保留向量名次）、e 零向量（0.0）。
  request({
    op: "hybrid_fuse",
    hits: [
      { chunk_id: "a", score: 10 }, { chunk_id: "b", score: 9 },
      { chunk_id: "c", score: 8 }, { chunk_id: "d", score: 7 },
      { chunk_id: "e", score: 6 },
    ],
    query_vector: [1, 0],
    vectors: { a: [1, 0], b: [0, 1], c: [2, 0], d: [1, 0, 0], e: [0, 0] },
    limit: 5, lexical_weight: 0.45, vector_weight: 0.55, rrf_k: 60,
    vector_version: "test-provider:test-model:2",
  });
  const response = await readResponse();
  assert.equal(response.status, "ok");
  assert.equal(response.fusion, "hybrid-rrf");
  assert.equal(response.fallback, null);
  assert.equal(response.vector_doc_count, 5);
  assert.equal(response.vector_version, "test-provider:test-model:2");
  // normalized_rrf(rank) = 61/(60+rank)；score = 0.45*词法 + 0.55*向量。
  assert.deepEqual(
    (response.results as Array<{ chunk_id: string }>).map((row) => row.chunk_id),
    ["a", "c", "b", "d", "e"],
  );
  const expected: Record<string, number> = {
    a: 1,
    b: 0.9752816180235535,
    c: 0.9768433179723502,
    d: 0.953125,
    e: 0.9384615384615385,
  };
  for (const row of response.results as Array<{ chunk_id: string; score: number }>) {
    assert.ok(Math.abs(row.score - expected[row.chunk_id]) < 1e-12, `score(${row.chunk_id})=${row.score}`);
  }
  child.stdin.end();
  await closed;
});

test("冻结契约：hybrid_fuse 无向量或全零命中时透传词法结果", async (t) => {
  const { request, readResponse, closed, child } = spawnWorker(t);
  const hits = [
    { chunk_id: "x", score: 3.5 }, { chunk_id: "y", score: 1.25 },
  ];
  request({ op: "hybrid_fuse", hits, query_vector: [], vectors: {}, limit: 1 });
  const passthrough = await readResponse();
  assert.equal(passthrough.status, "ok");
  assert.equal(passthrough.fusion, "bm25");
  assert.equal(passthrough.fallback, "embedding_cache_unavailable");
  assert.equal(passthrough.vector_doc_count, 0);
  assert.deepEqual(passthrough.results, [{ chunk_id: "x", score: 3.5 }]);
  child.stdin.end();
  await closed;
});

test("Phase 4：索引损坏与版本不匹配显式报告，重建后清除", async (t) => {
  const { rm, mkdir, writeFile, readFile, mkdtemp } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const os = await import("node:os");
  const dir = await mkdtemp(join(os.tmpdir(), "rag-corrupt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const spawnWith = async (indexDir: string) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts", indexDir],
      { cwd: workerDir });
    t.after(() => child.kill());
    return child;
  };
  const talk = async (child: import("node:child_process").ChildProcess) => {
    const lines = createInterface({ input: child.stdout });
    const pending: Array<(value: string) => void> = [];
    const received: string[] = [];
    lines.on("line", (line) => {
      const waiter = pending.shift();
      if (waiter) waiter(line); else received.push(line);
    });
    return {
      request: (payload: unknown) => child.stdin.write(JSON.stringify(payload) + "\n"),
      read: async () => JSON.parse(received.shift() ?? await new Promise<string>((r) => pending.push(r))) as Record<string, unknown>,
    };
  };

  // 1) 损坏的 index.json → restore_error=corrupt，且不得伪装成有数据。
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.json"), "{不是 JSON");
  const corrupted = await spawnWith(dir);
  const a = await talk(corrupted);
  a.request({ op: "ping" });
  const ping1 = await a.read();
  assert.equal(ping1.restore_error, "corrupt");
  assert.equal(ping1.revision, "");
  // 2) 全量重建后恢复健康：错误清除，revision 生效并落盘。
  a.request({ op: "replace", revision: "r1", documents: [
    { id: "d1", text: "重建后的正文", source_type: "file", scope_type: "owner", scope_id: "o1", document_version: "1" },
  ] });
  const rep = await a.read();
  assert.equal(rep.revision, "r1");
  a.request({ op: "ping" });
  const ping2 = await a.read();
  assert.equal(ping2.restore_error, null);
  assert.equal(ping2.document_count, 1);
  corrupted.stdin.end();
  await once(corrupted, "close");

  // 3) 版本不匹配 → version_mismatch；旧制品不能假装可用。
  const stored = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
  stored.version = "ancient-version";
  await writeFile(join(dir, "index.json"), JSON.stringify(stored));
  const stale = await spawnWith(dir);
  const b = await talk(stale);
  b.request({ op: "ping" });
  const ping3 = await b.read();
  assert.equal(ping3.restore_error, "version_mismatch");
  stale.stdin.end();
  await once(stale, "close");
});

test("Phase 4：并发 patch/replace/search 串行原子生效，检索不出现撕裂状态", async (t) => {
  const { request, readResponse, closed, child } = spawnWorker(t);
  request({ op: "replace", revision: "r0", documents: Array.from({ length: 5 }, (_, index) => ({
    id: `d${index}`, text: `初始缓存正文${index}`, source_type: "file",
    scope_type: "owner", scope_id: "o1", document_version: "1",
  })) });
  assert.equal((await readResponse()).revision, "r0");
  // 不等待响应地连续写入：patch(r1) → search → patch(r2) → search，验证顺序处理。
  request({ op: "patch", revision: "r1", base_revision: "r0",
    upserts: [{ id: "d9", text: "新增缓存正文", source_type: "file", scope_type: "owner", scope_id: "o1", document_version: "1" }],
    deletes: ["d0"] });
  request({ op: "search", revision: "r1", query: "缓存正文", limit: 10 });
  request({ op: "patch", revision: "r2", base_revision: "r1",
    upserts: [], deletes: ["d1", "d2"] });
  request({ op: "search", revision: "r2", query: "缓存正文", limit: 10 });
  const patch1 = await readResponse();
  assert.equal(patch1.status, "ok");
  const search1 = await readResponse();
  const patch2 = await readResponse();
  assert.equal(patch2.status, "ok");
  const search2 = await readResponse();
  assert.equal(search1.revision, "r1");
  assert.equal(search2.revision, "r2");
  // 每个搜索响应都与其声明的 revision 严格一致：不重不漏、无撕裂。
  assert.equal((search1.results as unknown[]).length, 5);
  assert.equal((search2.results as unknown[]).length, 3);
  child.stdin.end();
  await closed;
});

test("Phase 5：unified_query 与 batch_search+hybrid_fuse+rank 三段管线逐位一致", async (t) => {
  const { request, readResponse, closed, child } = spawnWorker(t);
  const docs = [
    { id: "file:1:0", text: "缓存文件的部署结论", source_type: "file", scope_type: "owner", scope_id: "o1", document_version: "1" },
    { id: "file:2:0", text: "缓存文件的架构说明", source_type: "file", scope_type: "owner", scope_id: "o1", document_version: "1" },
    { id: "conv:4:0", text: "会话里的缓存方案", source_type: "conversation", scope_type: "owner", scope_id: "o1", document_version: "m4", metadata: { kind: "message", message_id: 4 } },
    { id: "conv:5:0", text: "水位之后的缓存方案", source_type: "conversation", scope_type: "owner", scope_id: "o1", document_version: "m5", metadata: { kind: "message", message_id: 5 } },
  ];
  // 瞬态文档单列，保证参考管线与统一查询引用同一份 document 对象。
  const memoryDocs = [
    { id: "memory:m1:0", text: "缓存记忆与部署相关", source_type: "memory", scope_type: "owner", scope_id: "o1", document_version: "v1" },
    { id: "memory:m2:0", text: "另一条缓存记忆", source_type: "memory", scope_type: "owner", scope_id: "o1", document_version: "v1" },
  ];
  request({ op: "replace", revision: "r1", documents: docs });
  assert.equal((await readResponse()).revision, "r1");
  request({ op: "replace_transient", revision: "t1", documents: memoryDocs, vectors: { "memory:m1:0": [1, 0], "memory:m2:0": [0, 1] }, vector_version: "prov:model:2" });
  assert.equal((await readResponse()).revision, "t1");

  // ── 三段参考管线：batch_search + hybrid_fuse + rank_candidates ──
  request({ op: "batch_search", revision: "r1", transient_revision: "t1", query: "缓存", searches: [
    { id: "0", source_types: ["file"], limit: 20 },
    { id: "1", source_types: ["conversation"], limit: 20 },
    { id: "2", source_types: ["memory"], corpus: "transient", limit: 20 },
  ] });
  const batched = await readResponse();
  const bySource: Record<string, Array<{ id: string; score: number }>> = {};
  const specSources = ["file", "conversation", "memory"];
  (batched.batches as Array<{ results: Array<{ id: string; score: number }> }>).forEach((part, index) => {
    bySource[specSources[index]] = part.results;
  });
  const memoryHits = bySource.memory;
  // hybrid_fuse 协议按 chunk_id 查向量：瞬态文档的 chunk_id 即其 worker key。
  request({ op: "hybrid_fuse", hits: memoryHits.map((hit) => ({ chunk_id: hit.id })), query_vector: [1, 0],
    vectors: { "memory:m1:0": [1, 0], "memory:m2:0": [0, 1] }, limit: 20 });
  const fused = await readResponse();
  // 防退化：参考侧融合必须真生效，否则两边都纯词法时等价断言会虚过。
  assert.equal(fused.fusion, "hybrid-rrf");
  assert.equal((fused as Record<string, unknown>).vector_doc_count, 2);
  assert.equal((fused as Record<string, unknown>).fallback, null);
  const fusedScores = new Map((fused.results as Array<{ chunk_id: string; score: number }>).map((row) => [row.chunk_id, row.score]));
  const keyById = new Map<string, string>();
  const candidates = [
    ...bySource.file.map((hit) => {
      keyById.set(hit.id, hit.id);
      return { id: hit.id, source_type: "file", raw_score: hit.score, fusion: "bm25", fused_score: null as number | null, document: docs.find((doc) => doc.id === hit.id) };
    }),
    // 水位在排序前生效：conv:5:0 不进入参考候选（与统一查询同口径）。
    ...bySource.conversation.filter((hit) => hit.id !== "conv:5:0").map((hit) => {
      keyById.set(hit.id, hit.id);
      return { id: hit.id, source_type: "conversation", raw_score: hit.score, fusion: "bm25", fused_score: null as number | null, document: docs.find((doc) => doc.id === hit.id) };
    }),
    ...memoryHits.map((hit) => {
      const candidateId = `memory:${hit.id}:0`;
      keyById.set(candidateId, hit.id);
      return { id: candidateId, source_type: "memory", raw_score: fusedScores.get(hit.id)!, fusion: "bm25", fused_score: null as number | null, document: { ...memoryDocs.find((doc) => doc.id === hit.id)!, id: candidateId } };
    }),
  ];
  request({ op: "rank_candidates", query: "缓存", candidates, limit: 5, max_chars: 3000, max_per_source: 3, max_per_parent: 3, selection_mode: "confidence" });
  const reference = await readResponse();

  // ── 统一查询：同语料同参数一次完成 ──
  request({ op: "unified_query", revision: "r1", transient_revision: "t1", query: "缓存",
    query_vector: [1, 0], before_message_id: 5, source_order: ["memory", "knowledge", "project", "file", "canvas", "note", "conversation"],
    searches: [
      { id: "0", source_types: ["file"], limit: 20 },
      { id: "1", source_types: ["conversation"], limit: 20 },
      { id: "2", source_types: ["memory"], corpus: "transient", limit: 20 },
    ], candidate_limit: 20,
    rank: { limit: 5, max_chars: 3000, max_per_source: 3, max_per_parent: 3, selection_mode: "confidence" } });
  const unified = await readResponse() as Record<string, any>;
  assert.equal(unified.status, "ok");
  assert.equal(unified.fusion.fusion, "hybrid-rrf");
  assert.equal(unified.fusion.vector_doc_count, 2);
  assert.equal(unified.fusion.vector_version, "prov:model:2");
  assert.equal(unified.fusion.fallback, null);
  assert.equal(unified.stats.scoring_version, "confidence-v1");
  // 水位：message_id=5 的会话文档不参与。
  const unifiedRows = unified.selected as Array<{ document_key: string; confidence: number }>;
  const unifiedKeys = unifiedRows.map((row) => row.document_key);
  assert.ok(!unifiedKeys.includes("conv:5:0"));
  // 与参考管线（同水位口径）选中序列与 confidence 全等。
  const referenceRows = reference.selected as Array<{ id: string; confidence: number }>;
  assert.deepEqual(unifiedKeys, referenceRows.map((row) => keyById.get(row.id)));
  for (let index = 0; index < referenceRows.length; index += 1) {
    assert.ok(Math.abs(referenceRows[index].confidence - unifiedRows[index].confidence) < 1e-12,
      `confidence[${index}] ${referenceRows[index].confidence} vs ${unifiedRows[index].confidence}`);
  }
  child.stdin.end();
  await closed;
});
