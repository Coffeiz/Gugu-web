#!/usr/bin/env node

// ts/workers/rag/src/index.ts
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ts/packages/contracts/src/rag.ts
var RAG_WORKER_VERSION = "0.2.0";

// ts/workers/rag/src/tokenizer.ts
import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict.js";
var TOKEN_RE = /[A-Za-z0-9_]+|[\u4e00-\u9fff]+/gu;
var ASCII_RE = /^[\x00-\x7F]+$/u;
var jieba = Jieba.withDict(dict);
function segmentChinese(token) {
  return jieba.cut(token, false).filter((word) => /[\u4e00-\u9fff]/u.test(word));
}
function tokenizeRaw(text) {
  const normalized = (text || "").toLocaleLowerCase();
  const raw = normalized.match(TOKEN_RE) ?? [];
  const compact = normalized.replace(/(?<=[a-z])\s+(?=\d)|(?<=\d)\s+(?=[a-z])/gu, "");
  const compactTokens = (compact.match(TOKEN_RE) ?? []).filter((token) => !raw.includes(token));
  const output = [];
  for (const token of [...raw, ...compactTokens]) {
    if (ASCII_RE.test(token)) output.push(token);
    else output.push(...segmentChinese(token));
  }
  return output;
}

// ts/workers/rag/src/index.ts
var VERSION = RAG_WORKER_VERSION;
var K1 = 1.2;
var B = 0.75;
var HARD_FLOOR = 0.35;
var PREFERRED = 0.55;
var SCORING_VERSION = "confidence-v1";
var SOURCE_QUALITY = {
  memory: 0.8,
  project: 0.9,
  file: 0.8,
  canvas: 0.75,
  conversation: 0.65,
  journal: 0.7,
  knowledge: 0.8
};
function tokens(value) {
  return tokenizeRaw(value);
}
function termFrequency(items) {
  const out = /* @__PURE__ */ new Map();
  for (const item of items) out.set(item, (out.get(item) ?? 0) + 1);
  return out;
}
function makeState(indexDir2) {
  return { revision: "", documents: [], index: [], docFreq: /* @__PURE__ */ new Map(), avgLength: 0, totalLength: 0, indexDir: indexDir2 };
}
async function restore(state2) {
  if (!state2.indexDir) return;
  try {
    const raw = JSON.parse(await readFile(join(state2.indexDir, "index.json"), "utf8"));
    replaceInMemory(state2, raw.revision ?? "", raw.documents ?? []);
  } catch {
    state2.revision = "";
  }
}
function replaceInMemory(state2, revision, documents) {
  state2.revision = revision;
  state2.documents = documents;
  state2.index = [];
  state2.docFreq = /* @__PURE__ */ new Map();
  let total = 0;
  for (const document of documents) {
    const frequency = termFrequency(tokens(document.text));
    state2.index.push(frequency);
    total += [...frequency.values()].reduce((sum, value) => sum + value, 0);
    for (const term of frequency.keys()) state2.docFreq.set(term, (state2.docFreq.get(term) ?? 0) + 1);
  }
  state2.avgLength = documents.length ? total / documents.length : 0;
  state2.totalLength = total;
}
function patchInMemory(state2, revision, upserts, deletes) {
  const removeAt = (position) => {
    const frequency = state2.index[position];
    const length = [...frequency.values()].reduce((sum, value) => sum + value, 0);
    state2.totalLength -= length;
    for (const term of frequency.keys()) {
      const count = (state2.docFreq.get(term) ?? 0) - 1;
      if (count > 0) state2.docFreq.set(term, count);
      else state2.docFreq.delete(term);
    }
    state2.documents.splice(position, 1);
    state2.index.splice(position, 1);
  };
  const positions = new Map(state2.documents.map((document, index) => [document.id, index]));
  for (const id of deletes) {
    const position = positions.get(id);
    if (position === void 0) continue;
    removeAt(position);
    positions.clear();
    state2.documents.forEach((document, index) => positions.set(document.id, index));
  }
  for (const document of upserts) {
    const position = positions.get(document.id);
    if (position !== void 0) removeAt(position);
    const frequency = termFrequency(tokens(document.text));
    const length = [...frequency.values()].reduce((sum, value) => sum + value, 0);
    state2.documents.push(document);
    state2.index.push(frequency);
    state2.totalLength += length;
    for (const term of frequency.keys()) state2.docFreq.set(term, (state2.docFreq.get(term) ?? 0) + 1);
    positions.clear();
    state2.documents.forEach((item, index) => positions.set(item.id, index));
  }
  state2.revision = revision;
  state2.avgLength = state2.documents.length ? state2.totalLength / state2.documents.length : 0;
}
async function persist(state2) {
  if (!state2.indexDir) return;
  await mkdir(state2.indexDir, { recursive: true, mode: 448 });
  const target = join(state2.indexDir, "index.json");
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: VERSION, revision: state2.revision, documents: state2.documents }), { mode: 384 });
  await rename(temporary, target);
}
function search(state2, query, limit) {
  const terms = new Set(tokens(query));
  if (!terms.size) return [];
  const total = state2.documents.length;
  const scored = [];
  state2.documents.forEach((document, index) => {
    const frequency = state2.index[index];
    const length = Math.max(1, [...frequency.values()].reduce((sum, value) => sum + value, 0));
    let score = 0;
    for (const term of terms) {
      const tf = frequency.get(term) ?? 0;
      if (!tf) continue;
      const df = state2.docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      const norm = tf + K1 * (1 - B + B * length / (state2.avgLength || 1));
      score += idf * tf * (K1 + 1) / norm;
    }
    if (score > 0) scored.push({ id: document.id, score, source_type: document.source_type, document_version: document.document_version });
  });
  return scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, Math.max(1, Math.min(limit, 50)));
}
function queryMatch(query, candidate) {
  const queryTokens = new Set(tokens(query).filter((item) => !/^[\d\p{P}\p{S}_]+$/u.test(item)));
  if (!queryTokens.size) return 0;
  const text = `${candidate.title ?? ""}
${candidate.summary ?? ""}
${candidate.content ?? ""}`;
  const compactQuery = query.replace(/\s+/gu, "").toLocaleLowerCase();
  const compactText = text.replace(/\s+/gu, "").toLocaleLowerCase();
  if (compactQuery.length >= 2 && compactText.includes(compactQuery)) return 1;
  const documentTokens = new Set(tokens(text));
  let matches = 0;
  for (const item of queryTokens) if (documentTokens.has(item)) matches += 1;
  return matches / queryTokens.size;
}
function scoreFilter(query, candidates, limit) {
  const scored = candidates.map((candidate) => {
    let sourceQuality = SOURCE_QUALITY[candidate.source_type] ?? 0.7;
    if (candidate.source_type === "knowledge") {
      const weight = { confirmed: 1, probable: 0.85, unverified: 0.65, conflict: 0.35 }[candidate.confidence] ?? 0.65;
      sourceQuality *= weight;
    }
    const match = Math.min(1, queryMatch(query, candidate));
    const fused = Number(candidate.fused_score || candidate.normalized_score || 0);
    let confidence = 0.55 * fused + 0.25 * match + 0.2 * sourceQuality;
    if (match <= 0) confidence = Math.min(confidence, HARD_FLOOR - 0.01);
    return { ...candidate, confidence: Math.min(1, Math.max(0, confidence)), source_quality: sourceQuality };
  });
  const preferred = scored.filter((item) => item.confidence >= PREFERRED);
  const fallback = scored.filter((item) => item.confidence >= HARD_FLOOR && item.confidence < PREFERRED);
  const selected = (preferred.length ? preferred : fallback).slice(0, Math.max(1, Number(limit)));
  const selectedIds = new Set(selected.map((item) => item.id));
  return {
    selected,
    stats: {
      accepted_count: selected.length,
      rejected_low_score: scored.filter((item) => item.confidence < HARD_FLOOR).length,
      rejected_not_preferred: scored.filter((item) => preferred.length > 0 && item.confidence >= HARD_FLOOR && !selectedIds.has(item.id)).length,
      top_confidence: Math.max(0, ...scored.map((item) => item.confidence)),
      threshold: HARD_FLOOR,
      preferred_threshold: PREFERRED,
      scoring_version: SCORING_VERSION
    }
  };
}
function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
async function handle(state2, request) {
  if (request.op === "ping") return { status: "ok", version: VERSION, revision: state2.revision, document_count: state2.documents.length };
  if (request.op === "tokenize") return { status: "ok", version: VERSION, tokens: tokenizeRaw(String(request.text ?? "")) };
  if (request.op === "replace") {
    replaceInMemory(state2, request.revision ?? "", request.documents ?? []);
    await persist(state2);
    return { status: "ok", version: VERSION, revision: state2.revision, document_count: state2.documents.length };
  }
  if (request.op === "patch") {
    if ((request.base_revision ?? "") !== state2.revision && request.base_revision !== void 0) {
      return { status: "error", code: "revision_mismatch", message: "TS worker patch \u57FA\u7EBF revision \u4E0E\u5F53\u524D\u7D22\u5F15\u4E0D\u4E00\u81F4" };
    }
    patchInMemory(state2, request.revision ?? "", request.upserts ?? [], request.deletes ?? []);
    await persist(state2);
    return { status: "ok", version: VERSION, revision: state2.revision, document_count: state2.documents.length };
  }
  if (request.op === "search") {
    if ((request.revision ?? "") !== state2.revision) return { status: "error", code: "revision_mismatch", message: "TS sidecar revision \u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4" };
    const allowedSources = new Set(request.source_types ?? []);
    const result = search(state2, request.query ?? "", request.limit ?? 10).filter((item) => !allowedSources.size || allowedSources.has(item.source_type));
    return { status: "ok", version: VERSION, revision: state2.revision, results: result };
  }
  if (request.op === "score_filter") {
    const output = scoreFilter(request.query, request.candidates, request.limit ?? 10);
    return { status: "ok", version: VERSION, selected: output.selected, stats: output.stats, input_digest: digest(request.candidates ?? []) };
  }
  return { status: "error", code: "unknown_operation", message: "\u672A\u77E5\u64CD\u4F5C" };
}
var args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(`gugu-rag-ts-worker ${VERSION}`);
  process.exit(0);
}
var indexDir = args[0];
var state = makeState(indexDir);
await restore(state);
var input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let response;
  try {
    response = await handle(state, JSON.parse(line));
  } catch (error) {
    response = { status: "error", code: "worker_failure", message: error instanceof Error ? error.message : "worker failure" };
  }
  process.stdout.write(`${JSON.stringify(response)}
`);
}
