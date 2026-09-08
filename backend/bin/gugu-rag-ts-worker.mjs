#!/usr/bin/env node

// src/index.ts
import { createHash as createHash3 } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ../../packages/contracts/src/rag.ts
var RAG_WORKER_VERSION = "0.2.0";

// src/tokenizer.ts
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
  const compact2 = normalized.replace(/(?<=[a-z])\s+(?=\d)|(?<=\d)\s+(?=[a-z])/gu, "");
  const compactTokens = (compact2.match(TOKEN_RE) ?? []).filter((token) => !raw.includes(token));
  const output = [];
  for (const token of [...raw, ...compactTokens]) {
    if (ASCII_RE.test(token)) output.push(token);
    else output.push(...segmentChinese(token));
  }
  return output;
}

// src/adapters/base.ts
import { createHash } from "node:crypto";
function chunkText(text, maxChars = 1400, overlap = 120) {
  const normalized = String(text || "").trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n\s*\n/gu).map((part) => part.trim()).filter(Boolean);
  const output = [];
  let buffer = "";
  for (const paragraph of paragraphs) {
    const pieces = paragraph.split(/(?<=[。！？!?；;\n])/u).map((part) => part.trim()).filter(Boolean);
    for (const piece of pieces) {
      if (piece.length > maxChars) {
        if (buffer) {
          output.push(buffer.trim());
          buffer = "";
        }
        const step = Math.max(1, maxChars - overlap);
        for (let start = 0; start < piece.length; start += step) {
          const chunk = piece.slice(start, start + maxChars).trim();
          if (chunk) output.push(chunk);
        }
        continue;
      }
      const candidate = buffer ? `${buffer}
${piece}`.trim() : piece;
      if (buffer && candidate.length > maxChars) {
        output.push(buffer.trim());
        const tail = buffer.slice(-overlap).trim();
        buffer = tail ? `${tail}
${piece}`.trim() : piece;
      } else {
        buffer = candidate;
      }
    }
  }
  if (buffer) output.push(buffer.trim());
  return output;
}
function textVersion(text, ...parts) {
  const payload = [...parts.map((part) => String(part ?? "")), text].join("");
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}
function buildDocuments(record, maxChars = 1400) {
  const normalized = String(record.content || "").trim();
  const chunks = chunkText(normalized, maxChars);
  if (!chunks.length) return [];
  const parentId = `${record.source_type}:${record.id}`;
  const summary = record.summary || normalized.slice(0, 240);
  const parts = record.version_parts;
  const documentVersion = parts ? textVersion(normalized, ...parts) : record.document_version;
  const title = record.title || "\u672A\u547D\u540D";
  return chunks.map((text, chunkIndex) => ({
    id: `${record.source_type}:${parentId}:${chunkIndex}`,
    text: [title, summary, text].join("\n"),
    content: text,
    source_type: record.source_type,
    source_id: String(record.id),
    title,
    summary,
    ...record.scope,
    scope_type: record.scope.scope_type || "owner",
    scope_id: record.scope.scope_id || "",
    document_version: documentVersion,
    parent_id: parentId,
    chunk_index: chunkIndex,
    chunk_count: chunks.length,
    updated_at: record.updated_at,
    metadata: record.metadata
  }));
}
function validScope(scope) {
  if (!scope.scope_type) return false;
  if (scope.scope_type === "group" && !scope.scope_id) return false;
  return true;
}

// src/adapters/calendar.ts
var calendarAdapter = {
  sourceType: "calendar",
  toDocuments(records) {
    return records.flatMap((record) => {
      if (record.id === null || record.id === void 0 || !validScope(record.scope)) return [];
      const text = [
        `\u6D3B\u52A8\uFF1A${record.title}`,
        `\u65E5\u671F\uFF1A${record.date}`,
        `\u65F6\u95F4\uFF1A${record.time || "\u5168\u5929"}`,
        record.description || ""
      ].filter(Boolean).join("\n");
      return buildDocuments({
        id: String(record.id),
        source_type: "calendar",
        scope: record.scope,
        title: record.title,
        content: text,
        document_version: record.document_version ?? "",
        version_parts: record.version_parts,
        metadata: {
          event_id: String(record.id),
          project_id: record.project_id == null ? "" : String(record.project_id)
        }
      });
    });
  }
};

// src/adapters/canvas.ts
var canvasAdapter = {
  sourceType: "canvas",
  toDocuments(records) {
    return records.flatMap((record) => {
      if (record.id === null || record.id === void 0 || record.canvas_id === null || record.canvas_id === void 0 || record.node_id === null || record.node_id === void 0 || !validScope(record.scope)) return [];
      const text = [
        `\u753B\u5E03\uFF1A${record.canvas_title || "\u672A\u547D\u540D\u753B\u5E03"}`,
        `\u8282\u70B9\uFF1A${record.node_title || "\u672A\u547D\u540D\u8282\u70B9"}`,
        `\u7C7B\u578B\uFF1A${record.node_type}`,
        record.group_path ? `\u5206\u7EC4\uFF1A${record.group_path}` : "",
        record.relation_summary ? `\u5173\u7CFB\uFF1A${record.relation_summary}` : "",
        record.content || ""
      ].filter(Boolean).join("\n");
      return buildDocuments({
        id: String(record.id),
        source_type: "canvas",
        scope: record.scope,
        title: `${record.canvas_title || "\u672A\u547D\u540D\u753B\u5E03"} \xB7 ${record.node_title || "\u672A\u547D\u540D\u8282\u70B9"}`,
        content: text,
        document_version: record.document_version ?? "",
        version_parts: record.version_parts,
        updated_at: record.updated_at,
        metadata: {
          canvas_id: String(record.canvas_id),
          node_id: String(record.node_id),
          node_type: record.node_type,
          group_path: record.group_path || "",
          project_id: record.project_id == null ? "" : String(record.project_id),
          relation_summary: record.relation_summary || ""
        }
      });
    });
  }
};

// src/adapters/conversations.ts
var buildMetadata = (record) => {
  const metadata = {
    session_id: String(record.session_id),
    kind: record.kind,
    session_source: record.session_source || "",
    session_updated_at: record.session_updated_at || ""
  };
  if (record.kind === "message") {
    metadata.message_id = String(record.id);
    metadata.role = record.role ?? "";
  }
  return metadata;
};
var conversationAdapter = {
  sourceType: "conversation",
  toDocuments(records) {
    return records.flatMap((record) => {
      if (record.id === null || record.id === void 0 || !validScope(record.scope)) return [];
      const body = record.kind === "summary" ? record.summary ?? "" : record.content ?? "";
      if (!body.trim()) return [];
      if (record.kind === "message" && !record.role) return [];
      return buildDocuments({
        id: String(record.id),
        source_type: "conversation",
        scope: record.scope,
        title: record.title || "\u672A\u547D\u540D",
        content: record.kind === "summary" ? `\u4F1A\u8BDD\u6458\u8981\uFF1A${body}` : `${record.role}\uFF1A${body}`,
        document_version: record.document_version ?? "",
        version_parts: record.version_parts,
        updated_at: record.updated_at,
        metadata: buildMetadata(record)
      });
    });
  }
};

// src/adapters/files.ts
var fileAdapter = {
  sourceType: "file",
  toDocuments(records) {
    return records.flatMap((record) => {
      if (record.id === null || record.id === void 0 || !validScope(record.scope)) return [];
      const text = [
        `\u6587\u4EF6\uFF1A${record.title}`,
        record.ext ? `\u7C7B\u578B\uFF1A${record.ext}` : "",
        record.space ? `\u7A7A\u95F4\uFF1A${record.space}` : "",
        record.stage_name ? `\u9636\u6BB5\uFF1A${record.stage_name}` : "",
        record.content || ""
      ].filter(Boolean).join("\n");
      return buildDocuments({
        id: String(record.id),
        source_type: "file",
        scope: record.scope,
        title: record.title,
        content: text,
        document_version: record.document_version ?? "",
        version_parts: record.version_parts,
        updated_at: record.updated_at,
        metadata: {
          file_id: String(record.id),
          mime_type: record.mime_type || "",
          project_id: record.project_id == null ? "" : String(record.project_id),
          folder_id: record.folder_id == null ? "" : String(record.folder_id),
          space: record.space || ""
        }
      });
    });
  }
};

// src/adapters/note.ts
var noteAdapter = {
  sourceType: "note",
  toDocuments(records) {
    return records.flatMap((record) => {
      if (record.id === null || record.id === void 0 || !validScope(record.scope)) return [];
      const text = [
        record.title || "",
        record.content_plain || record.content_md || ""
      ].filter(Boolean).join("\n");
      return buildDocuments({
        id: String(record.id),
        source_type: "note",
        scope: record.scope,
        title: record.title || "\u4FBF\u7B7E",
        content: text,
        document_version: record.document_version ?? "",
        version_parts: record.version_parts,
        updated_at: record.updated_at,
        metadata: {
          node_id: String(record.id),
          kind: record.kind
        }
      });
    });
  }
};

// src/adapters/scheduled-tasks.ts
var scheduledTaskAdapter = {
  sourceType: "scheduled_task",
  toDocuments(records) {
    return records.flatMap((record) => {
      if (record.id === null || record.id === void 0 || !validScope(record.scope)) return [];
      const text = `\u5B9A\u65F6\u4EFB\u52A1\uFF1A${record.name}
\u8BA1\u5212\uFF1A${record.cron}
\u72B6\u6001\uFF1A${record.enabled ? "\u542F\u7528" : "\u505C\u7528"}
${record.payload || ""}`;
      return buildDocuments({
        id: String(record.id),
        source_type: "scheduled_task",
        scope: record.scope,
        title: record.name,
        content: text,
        document_version: record.document_version ?? "",
        version_parts: record.version_parts,
        metadata: {
          task_id: String(record.id),
          enabled: record.enabled
        }
      });
    });
  }
};

// src/index-builder.ts
function buildGenericDocuments(records) {
  return records.flatMap((record) => {
    if (record.id === null || record.id === void 0 || !record.source_type || !record.title || !record.scope?.scope_type || !record.scope?.scope_id) return [];
    return buildDocuments(record);
  });
}
function buildSourceDocuments(batch) {
  return [
    ...buildGenericDocuments(batch.memory || []),
    ...buildGenericDocuments(batch.project || []),
    ...fileAdapter.toDocuments(batch.files || []),
    ...noteAdapter.toDocuments(batch.note || []),
    ...canvasAdapter.toDocuments(batch.canvas || []),
    ...calendarAdapter.toDocuments(batch.calendar || []),
    ...scheduledTaskAdapter.toDocuments(batch.scheduled_task || []),
    ...conversationAdapter.toDocuments(batch.conversations || []),
    ...buildGenericDocuments(batch.knowledge || [])
  ];
}

// src/service.ts
import { createHash as createHash2 } from "node:crypto";
function compact(value) {
  return String(value || "").replace(/\s+/gu, "").trim().toLocaleLowerCase();
}
function digest(value) {
  return createHash2("sha256").update(value).digest("hex");
}
function contentHashes(value) {
  const text = String(value || "").trim();
  return [digest(text), digest(text.replace(/\s+/gu, ""))];
}
function contentKey(value) {
  return digest(compact(value));
}
function citation(document) {
  const metadata = document.metadata ?? {};
  const sourceId = String(metadata.source_id ?? document.parent_id ?? document.id);
  const chunkId = `${document.parent_id ?? document.id}:${document.document_version}:${document.chunk_index ?? 0}`;
  return {
    source_type: document.source_type,
    source_id: sourceId,
    title: String(document.title ?? "\u672A\u547D\u540D\u6765\u6E90"),
    chunk_id: chunkId,
    version: document.document_version,
    ...document.updated_at ? { updated_at: document.updated_at } : {}
  };
}
function tokenSet(document) {
  return new Set(terms(document.text));
}
function terms(value) {
  return tokenizeRaw(value);
}
function similarity(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  const union = (/* @__PURE__ */ new Set([...left, ...right])).size;
  return union ? intersection / union : 0;
}
var SOURCE_QUALITY = {
  memory: 0.8,
  project: 0.9,
  file: 0.8,
  canvas: 0.75,
  conversation: 0.65,
  journal: 0.7,
  knowledge: 0.8
};
var SOURCE_PRIORITY = {
  memory: 0,
  project: 10,
  file: 20,
  journal: 30,
  canvas: 40,
  conversation: 50
};
function normalizeBySource(candidates) {
  const grouped = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.source_type) ?? [];
    group.push(candidate);
    grouped.set(candidate.source_type, group);
  }
  const normalized = /* @__PURE__ */ new Map();
  for (const group of grouped.values()) {
    const scores = group.map((candidate) => Number(candidate.raw_score || 0));
    const low = Math.min(...scores);
    const high = Math.max(...scores);
    for (const candidate of group) {
      const score = Number(candidate.raw_score || 0);
      normalized.set(candidate.id, high <= low ? Math.max(0, score) / (1 + Math.max(0, score)) : (score - low) / (high - low));
    }
  }
  return normalized;
}
function queryMatch(query, document) {
  const meaningful = new Set(terms(query).filter((token) => !/^[\d\p{P}\p{S}_]+$/u.test(token)));
  if (!meaningful.size) return 0;
  const text = `${document.title ?? ""}
${document.summary ?? ""}
${document.text ?? ""}`;
  const compactQuery = String(query || "").replace(/\s+/gu, "").toLocaleLowerCase();
  const compactText = text.replace(/\s+/gu, "").toLocaleLowerCase();
  if (compactQuery.length >= 2 && compactText.includes(compactQuery)) return 1;
  const documentTerms = new Set(terms(text));
  let matched = 0;
  for (const token of meaningful) if (documentTerms.has(token)) matched += 1;
  return matched / meaningful.size;
}
function confidence(candidate, fused, query) {
  let sourceQuality = SOURCE_QUALITY[candidate.source_type] ?? 0.7;
  if (candidate.source_type === "knowledge") {
    const weight = { confirmed: 1, probable: 0.85, unverified: 0.65, conflict: 0.35 }[String(candidate.document.metadata?.confidence ?? "")] ?? 0.65;
    sourceQuality *= weight;
  }
  const match = Math.min(1, queryMatch(query, candidate.document));
  let value = 0.55 * fused + 0.25 * match + 0.2 * sourceQuality;
  if (match <= 0) value = Math.min(value, 0.35 - 0.01);
  return { value: Math.min(1, Math.max(0, value)), sourceQuality };
}
function rankCandidates(query, candidates, options = {}) {
  const started = performance.now();
  const excluded = new Set(options.excludeContentHashes ?? []);
  const eligible = candidates.filter(
    (candidate) => !contentHashes(candidate.document.text).some((hash) => excluded.has(hash))
  );
  const normalized = normalizeBySource(eligible);
  const scored = eligible.map((candidate) => {
    const normalizedScore = normalized.get(candidate.id) ?? 0;
    const fused = candidate.fused_score !== void 0 && candidate.fused_score !== null ? Number(candidate.fused_score) : candidate.fusion === "hybrid-rrf" ? Number(candidate.raw_score || 0) : normalizedScore;
    const quality = confidence(candidate, fused, query);
    return { candidate, normalizedScore, fused, ...quality };
  });
  const orderedScored = [...scored].sort(
    (left, right) => right.fused - left.fused || (SOURCE_PRIORITY[left.candidate.source_type] ?? 100) - (SOURCE_PRIORITY[right.candidate.source_type] ?? 100) || String(right.candidate.document.updated_at ?? "").localeCompare(String(left.candidate.document.updated_at ?? "")) || String(left.candidate.document.document_version).localeCompare(String(right.candidate.document.document_version)) || String(left.candidate.document.id).localeCompare(String(right.candidate.document.id))
  );
  const selectionMode = options.selectionMode ?? "confidence";
  const preferred = orderedScored.filter((item) => item.value >= 0.55);
  const fallback = orderedScored.filter((item) => item.value >= 0.35 && item.value < 0.55);
  const confidenceSelected = (selectionMode === "top_k" ? orderedScored : preferred.length ? preferred : fallback).slice(0, Math.max(1, Number(options.limit ?? 5)));
  const selectedIds = new Set(confidenceSelected.map((item) => item.candidate.id));
  const ordered = confidenceSelected;
  const unified = selectUnifiedRecall(
    ordered.map((item) => ({ result: { id: item.candidate.id, score: item.fused, source_type: item.candidate.source_type, document_version: item.candidate.document.document_version }, document: { ...item.candidate.document, id: item.candidate.id, text: item.candidate.document.text } })),
    options
  );
  const byId = new Map(ordered.map((item) => [item.candidate.id, item]));
  const citationsByContent = /* @__PURE__ */ new Map();
  for (const item of eligible) {
    const key = contentKey(item.document.text);
    const values = citationsByContent.get(key) ?? [];
    const next = citation(item.document);
    if (!values.some((value) => JSON.stringify(value) === JSON.stringify(next))) values.push(next);
    citationsByContent.set(key, values);
  }
  const results = unified.results.map((document) => {
    const item = byId.get(document.id);
    const itemCitation = citation(document);
    const citations = citationsByContent.get(contentKey(document.text)) ?? [itemCitation];
    return {
      id: document.id,
      text: document.text,
      confidence: item?.value ?? 0,
      source_quality: item?.sourceQuality ?? 0,
      normalized_score: item?.normalizedScore ?? 0,
      fused_score: item?.fused ?? 0,
      citation: itemCitation,
      citations
    };
  });
  const sourceDiagnostics = {};
  for (const candidate of candidates) {
    const source = candidate.source_type;
    const entry = sourceDiagnostics[source] ?? { candidate_count: 0, eligible_count: 0, accepted_count: 0 };
    entry.candidate_count += 1;
    sourceDiagnostics[source] = entry;
  }
  for (const candidate of eligible) {
    sourceDiagnostics[candidate.source_type].eligible_count += 1;
  }
  for (const document of results) {
    sourceDiagnostics[document.citation.source_type].accepted_count += 1;
  }
  const stats = {
    ...unified.diagnostics,
    accepted_count: results.length,
    rejected_low_score: selectionMode === "confidence" ? scored.filter((item) => item.value < 0.35).length : 0,
    rejected_not_preferred: selectionMode === "confidence" ? scored.filter((item) => preferred.length > 0 && item.value >= 0.35 && !selectedIds.has(item.candidate.id)).length : 0,
    top_confidence: Math.max(0, ...scored.map((item) => item.value)),
    threshold: 0.35,
    preferred_threshold: 0.55,
    selection_mode: selectionMode,
    scoring_version: "confidence-v1",
    source_diagnostics: sourceDiagnostics,
    elapsed_ms: Math.round(performance.now() - started)
  };
  return { results, diagnostics: stats };
}
function selectUnifiedRecall(candidates, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit ?? 5), 50));
  const maxChars = Math.max(1, Number(options.maxChars ?? 3e3));
  const maxPerSource = Math.max(1, Number(options.maxPerSource ?? 3));
  const maxPerParent = Math.max(1, Number(options.maxPerParent ?? 3));
  const selected = [];
  const hashes = /* @__PURE__ */ new Set();
  const parentCounts = /* @__PURE__ */ new Map();
  const sourceCounts = /* @__PURE__ */ new Map();
  const selectedTokens = [];
  let outputChars = 0;
  let rejectedDuplicate = 0;
  let rejectedParent = 0;
  let rejectedSource = 0;
  let rejectedSimilarity = 0;
  const diversityLimited = options.selectionMode !== "top_k";
  const ordered = [...candidates].sort(
    (left, right) => right.result.score - left.result.score || left.result.id.localeCompare(right.result.id)
  );
  for (const { document } of ordered) {
    const text = String(document.text || "").trim();
    if (!text) continue;
    const hash = digest(compact(text));
    if (hashes.has(hash)) {
      rejectedDuplicate += 1;
      continue;
    }
    const parent = document.parent_id || document.id;
    if (diversityLimited && (parentCounts.get(parent) ?? 0) >= maxPerParent) {
      rejectedParent += 1;
      continue;
    }
    if (diversityLimited && (sourceCounts.get(document.source_type) ?? 0) >= maxPerSource) {
      rejectedSource += 1;
      continue;
    }
    const tokens2 = tokenSet(document);
    if (diversityLimited && selectedTokens.some((previous) => similarity(tokens2, previous) >= 0.85)) {
      rejectedSimilarity += 1;
      continue;
    }
    const remaining = maxChars - outputChars;
    if (remaining <= 0) break;
    const next = text.length > remaining ? { ...document, text: text.slice(0, remaining).trimEnd() } : document;
    if (!next.text) continue;
    selected.push(next);
    hashes.add(hash);
    selectedTokens.push(tokens2);
    parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1);
    sourceCounts.set(document.source_type, (sourceCounts.get(document.source_type) ?? 0) + 1);
    outputChars += next.text.length;
    if (selected.length >= limit) break;
  }
  return {
    results: selected,
    has_more: ordered.length > selected.length,
    diagnostics: {
      candidate_count: ordered.length,
      accepted_count: selected.length,
      rejected_duplicate: rejectedDuplicate,
      rejected_parent: rejectedParent,
      rejected_source: rejectedSource,
      rejected_similarity: rejectedSimilarity,
      output_chars: outputChars
    }
  };
}

// src/index.ts
var VERSION = RAG_WORKER_VERSION;
var K1 = 1.2;
var B = 0.75;
function tokens(value) {
  return tokenizeRaw(value);
}
function hybridFuseScores(hits, queryVector, vectors, lexicalWeight, vectorWeight, rrfK) {
  const getVector = (key) => vectors instanceof Map ? vectors.get(key) : vectors[key];
  const vectorScores = /* @__PURE__ */ new Map();
  for (const hit of hits) {
    const key = String(hit.chunk_id);
    const vector = getVector(key);
    if (!Array.isArray(vector) || vector.length === 0) continue;
    if (queryVector.length !== vector.length) {
      vectorScores.set(key, 0);
      continue;
    }
    let dot = 0, na = 0, nb = 0;
    for (let index = 0; index < queryVector.length; index += 1) {
      dot += queryVector[index] * vector[index];
      na += queryVector[index] * queryVector[index];
      nb += vector[index] * vector[index];
    }
    vectorScores.set(key, na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb)));
  }
  const fusedScores = /* @__PURE__ */ new Map();
  if (vectorScores.size === 0) {
    return { fusedScores, vectorDocCount: 0 };
  }
  const rrf = (rank, weight) => weight * ((rrfK + 1) / (rrfK + Math.max(1, rank)));
  const lexicalRanks = new Map(hits.map((hit, index) => [String(hit.chunk_id), index + 1]));
  const vectorRanked = [...vectorScores.keys()].sort((left, right) => vectorScores.get(right) - vectorScores.get(left) || (left < right ? -1 : 1));
  const vectorRanks = new Map(vectorRanked.map((key, index) => [key, index + 1]));
  for (const hit of hits) {
    const key = String(hit.chunk_id);
    let score = rrf(lexicalRanks.get(key) ?? 1, lexicalWeight);
    const vectorRank = vectorRanks.get(key);
    if (vectorRank !== void 0) score += rrf(vectorRank, vectorWeight);
    fusedScores.set(key, score);
  }
  return { fusedScores, vectorDocCount: vectorScores.size };
}
function termFrequency(items) {
  const out = /* @__PURE__ */ new Map();
  for (const item of items) out.set(item, (out.get(item) ?? 0) + 1);
  return out;
}
function makeState(indexDir2) {
  return {
    revision: "",
    restoreError: null,
    vectors: /* @__PURE__ */ new Map(),
    vectorVersion: "",
    documents: [],
    documentsById: /* @__PURE__ */ new Map(),
    postings: /* @__PURE__ */ new Map(),
    lengths: /* @__PURE__ */ new Map(),
    docFreq: /* @__PURE__ */ new Map(),
    avgLength: 0,
    totalLength: 0,
    indexDir: indexDir2
  };
}
async function restore(state2) {
  if (!state2.indexDir) return;
  let raw;
  try {
    raw = await readFile(join(state2.indexDir, "index.json"), "utf8");
  } catch {
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed.version !== VERSION) {
      state2.restoreError = "version_mismatch";
      return;
    }
    replaceInMemory(state2, parsed.revision ?? "", parsed.documents ?? []);
  } catch {
    state2.restoreError = "corrupt";
  }
}
function replaceInMemory(state2, revision, documents) {
  state2.revision = revision;
  state2.documents = [];
  state2.documentsById = /* @__PURE__ */ new Map();
  state2.postings = /* @__PURE__ */ new Map();
  state2.lengths = /* @__PURE__ */ new Map();
  state2.docFreq = /* @__PURE__ */ new Map();
  state2.totalLength = 0;
  for (const document of documents) addDocument(state2, document);
  state2.avgLength = state2.documents.length ? state2.totalLength / state2.documents.length : 0;
}
function addDocument(state2, document) {
  state2.documents.push(document);
  state2.documentsById.set(document.id, document);
  const frequency = termFrequency(tokens(document.text));
  const length = [...frequency.values()].reduce((sum, value) => sum + value, 0);
  state2.lengths.set(document.id, length);
  state2.totalLength += length;
  for (const [term, count] of frequency) {
    const posting = state2.postings.get(term) ?? { ids: [], frequencies: [] };
    posting.ids.push(document.id);
    posting.frequencies.push(count);
    state2.postings.set(term, posting);
    state2.docFreq.set(term, (state2.docFreq.get(term) ?? 0) + 1);
  }
}
function removeDocument(state2, id) {
  const document = state2.documentsById.get(id);
  if (!document) return;
  const frequency = termFrequency(tokens(document.text));
  const length = state2.lengths.get(id) ?? 0;
  state2.totalLength -= length;
  for (const term of frequency.keys()) {
    const posting = state2.postings.get(term);
    if (!posting) continue;
    const position = posting.ids.indexOf(id);
    if (position >= 0) {
      posting.ids.splice(position, 1);
      posting.frequencies.splice(position, 1);
    }
    const count = (state2.docFreq.get(term) ?? 0) - 1;
    if (count > 0) state2.docFreq.set(term, count);
    else {
      state2.docFreq.delete(term);
      state2.postings.delete(term);
    }
  }
  state2.documents = state2.documents.filter((item) => item.id !== id);
  state2.documentsById.delete(id);
  state2.lengths.delete(id);
}
function patchInMemory(state2, revision, upserts, deletes) {
  for (const id of deletes) removeDocument(state2, id);
  for (const document of upserts) {
    removeDocument(state2, document.id);
    addDocument(state2, document);
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
function matchesScope(document, scope) {
  if (!scope) return true;
  if (scope.scope_type === "project" || scope.scope_type === "folder") {
    if (document.scope_type !== "owner") return false;
    const field = scope.scope_type === "project" ? "project_id" : "folder_id";
    return String(document.metadata?.[field] ?? "") === String(scope.scope_id ?? "");
  }
  if (scope.scope_type === "member" && document.scope_type === "group") {
    return document.platform === scope.platform && document.bot_id === scope.bot_id && document.group_id === scope.group_id;
  }
  for (const key of ["platform", "bot_id", "group_id", "scope_type", "scope_id"]) {
    const wanted = scope[key];
    if (wanted && document[key] !== wanted) return false;
  }
  return true;
}
function scoreTerms(state2, terms2) {
  const scores = /* @__PURE__ */ new Map();
  for (const term of terms2) {
    const posting = state2.postings.get(term);
    if (!posting) continue;
    const idf = Math.log(1 + (state2.documents.length - posting.ids.length + 0.5) / (posting.ids.length + 0.5));
    posting.ids.forEach((id, position) => {
      const tf = posting.frequencies[position];
      const length = Math.max(1, state2.lengths.get(id) ?? 0);
      const norm = tf + K1 * (1 - B + B * length / (state2.avgLength || 1));
      scores.set(id, (scores.get(id) ?? 0) + idf * tf * (K1 + 1) / norm);
    });
  }
  return scores;
}
function search(state2, query, limit, allowedSources, scope, preparedScores, preparedTerms) {
  const started = performance.now();
  const terms2 = preparedTerms ?? new Set(tokens(query));
  if (!terms2.size) {
    return {
      results: [],
      diagnostics: {
        candidate_count: state2.documents.length,
        eligible_count: 0,
        filtered_count: state2.documents.length,
        source_filter_applied: allowedSources.size > 0,
        scope_filter_applied: scope !== void 0,
        elapsed_ms: Math.round(performance.now() - started)
      }
    };
  }
  const scored = [];
  let eligibleCount = 0;
  state2.documents.forEach((document) => {
    if (allowedSources.size && !allowedSources.has(document.source_type) || !matchesScope(document, scope)) return;
    eligibleCount += 1;
  });
  const scores = preparedScores ?? scoreTerms(state2, terms2);
  for (const [id, score] of scores) {
    const document = state2.documentsById.get(id);
    if (document && score > 0 && (!allowedSources.size || allowedSources.has(document.source_type)) && matchesScope(document, scope)) scored.push({ id, score, source_type: document.source_type, document_version: document.document_version, document });
  }
  return {
    results: scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, Math.max(1, Math.min(limit, 50))),
    diagnostics: {
      candidate_count: state2.documents.length,
      eligible_count: eligibleCount,
      filtered_count: state2.documents.length - eligibleCount,
      source_filter_applied: allowedSources.size > 0,
      scope_filter_applied: scope !== void 0,
      elapsed_ms: Math.round(performance.now() - started)
    }
  };
}
function digest2(value) {
  return createHash3("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
async function handle(state2, transient2, request) {
  if (request.op === "replace_transient") {
    replaceInMemory(transient2, request.revision ?? "", request.documents ?? []);
    const vectors = request.vectors;
    transient2.vectors = new Map(Object.entries(vectors ?? {}));
    transient2.vectorVersion = String(request.vector_version ?? "");
    return { status: "ok", version: VERSION, revision: transient2.revision, document_count: transient2.documents.length };
  }
  if (request.op === "unified_query") {
    const searches = Array.isArray(request.searches) ? request.searches : [];
    const hasTransient = searches.some((item) => item.corpus === "transient");
    if (request.revision !== state2.revision) return { status: "error", code: "revision_mismatch", message: "TS \u7EDF\u4E00\u67E5\u8BE2\u7D22\u5F15\u7248\u672C\u4E0D\u4E00\u81F4" };
    if (hasTransient && (!(request.transient_revision ?? "") || request.transient_revision !== transient2.revision)) {
      return { status: "error", code: "revision_mismatch", message: "TS \u7EDF\u4E00\u67E5\u8BE2\u77AC\u6001\u8BED\u6599\u7248\u672C\u4E0D\u4E00\u81F4" };
    }
    const terms2 = new Set(tokens(request.query));
    const persistentScores = scoreTerms(state2, terms2);
    const transientScores = hasTransient ? scoreTerms(transient2, terms2) : void 0;
    const candidateLimit = Math.max(1, Math.min(Number(request.candidate_limit ?? 20), 50));
    const sourceOrder = Array.isArray(request.source_order) ? request.source_order.map(String) : [];
    const groupOrder = [];
    const groups = /* @__PURE__ */ new Map();
    for (const item of searches) {
      const corpus = item.corpus === "transient" ? transient2 : state2;
      const preparedScores = item.corpus === "transient" ? transientScores : persistentScores;
      const found = search(corpus, request.query, candidateLimit, new Set(item.source_types ?? []), item.scope, preparedScores, terms2);
      for (const hit of found.results) {
        const source = hit.document.source_type;
        let group = groups.get(source);
        if (!group) {
          group = [];
          groups.set(source, group);
          groupOrder.push(source);
        }
        if (group.some((existing) => existing.key === hit.id)) continue;
        group.push({ key: hit.id, score: hit.score, document: hit.document });
      }
    }
    const merged = /* @__PURE__ */ new Map();
    for (const [source, group] of groups) {
      const ordered = group.sort((left, right) => right.score - left.score || (left.key < right.key ? -1 : 1)).slice(0, candidateLimit);
      merged.set(source, ordered);
    }
    const beforeMessageId = request.before_message_id;
    if (beforeMessageId !== void 0 && beforeMessageId !== null) {
      for (const [source, group] of merged) {
        if (source !== "conversation") continue;
        merged.set(source, group.filter(({ document }) => {
          const metadata = document.metadata ?? {};
          if (String(metadata.kind ?? "") !== "message") return true;
          const raw = metadata.message_id;
          const value = Number(raw);
          return Number.isFinite(value) && value < beforeMessageId;
        }));
      }
    }
    const queryVector = Array.isArray(request.query_vector) ? request.query_vector : [];
    const memoryGroup = merged.get("memory");
    let fusion = {
      fusion: "bm25",
      vector_doc_count: 0,
      vector_version: transient2.vectorVersion,
      fallback: "embedding_cache_unavailable"
    };
    if (memoryGroup && memoryGroup.length && queryVector.length && transient2.vectors.size) {
      const lexicalWeight = Number(request.lexical_weight ?? 0.45);
      const vectorWeight = Number(request.vector_weight ?? 0.55);
      const rrfK = Number(request.rrf_k ?? 60);
      const hits = memoryGroup.map((item) => ({ chunk_id: item.key }));
      const { fusedScores, vectorDocCount } = hybridFuseScores(
        hits,
        queryVector,
        transient2.vectors,
        lexicalWeight,
        vectorWeight,
        rrfK
      );
      if (fusedScores.size) {
        merged.set("memory", memoryGroup.map((item) => ({
          ...item,
          score: fusedScores.get(item.key) ?? item.score
        })));
        fusion = { fusion: "hybrid-rrf", vector_doc_count: vectorDocCount, vector_version: transient2.vectorVersion, fallback: null };
      }
    } else if (memoryGroup && memoryGroup.length && queryVector.length && !transient2.vectors.size) {
      fusion = { fusion: "bm25", vector_doc_count: 0, vector_version: transient2.vectorVersion, fallback: "embedding_cache_unavailable" };
    }
    const orderedSources = [
      ...sourceOrder.filter((source) => merged.has(source)),
      ...groupOrder.filter((source) => !sourceOrder.includes(source))
    ];
    const payload = [];
    const keysByCandidateId = /* @__PURE__ */ new Map();
    for (const source of orderedSources) {
      for (const item of merged.get(source)) {
        const candidateId = `${source}:${item.key}:${payload.length}`;
        keysByCandidateId.set(candidateId, item.key);
        payload.push({
          id: candidateId,
          source_type: source,
          raw_score: item.score,
          fusion: "bm25",
          fused_score: null,
          document: { ...item.document, id: candidateId }
        });
      }
    }
    const rankOptions = request.rank ?? {};
    const ranked = rankCandidates(request.query, payload, {
      limit: Number(rankOptions.limit ?? 5),
      maxChars: Number(rankOptions.max_chars ?? 3e3),
      maxPerSource: Number(rankOptions.max_per_source ?? 3),
      maxPerParent: Number(rankOptions.max_per_parent ?? 3),
      excludeContentHashes: rankOptions.exclude_content_hashes ?? [],
      selectionMode: rankOptions.selection_mode ?? "confidence"
    });
    const document_counts = {};
    for (const corpus of [state2, transient2]) {
      for (const document of corpus.documents) {
        document_counts[document.source_type] = (document_counts[document.source_type] ?? 0) + 1;
      }
    }
    const source_groups = {};
    for (const [source, group] of merged) {
      source_groups[source] = { candidate_count: group.length, hit_count: group.length };
    }
    return {
      status: "ok",
      version: VERSION,
      revision: state2.revision,
      selected: ranked.results.map((row) => ({
        ...row,
        document_key: keysByCandidateId.get(row.id) ?? "",
        raw_score: Number(payload.find((candidate) => candidate.id === row.id)?.raw_score ?? 0)
      })),
      stats: ranked.diagnostics,
      fusion,
      document_counts,
      source_groups
    };
  }
  if (request.op === "batch_search") {
    const hasTransient = request.searches.some((item) => item.corpus === "transient");
    if (request.revision !== state2.revision) return { status: "error", code: "revision_mismatch", message: "TS \u6279\u91CF\u67E5\u8BE2\u7D22\u5F15\u7248\u672C\u4E0D\u4E00\u81F4" };
    if (hasTransient && (!(request.transient_revision ?? "") || request.transient_revision !== transient2.revision)) {
      return { status: "error", code: "revision_mismatch", message: "TS \u6279\u91CF\u67E5\u8BE2\u77AC\u6001\u8BED\u6599\u7248\u672C\u4E0D\u4E00\u81F4" };
    }
    if (new Set(request.searches.map((item) => item.id)).size !== request.searches.length) {
      return { status: "error", code: "duplicate_search_id", message: "\u6279\u91CF\u67E5\u8BE2\u6807\u8BC6\u91CD\u590D" };
    }
    const terms2 = new Set(tokens(request.query));
    const persistentScores = scoreTerms(state2, terms2);
    const transientScores = hasTransient ? scoreTerms(transient2, terms2) : void 0;
    const document_counts = {};
    for (const corpus of [state2, transient2]) {
      for (const document of corpus.documents) {
        document_counts[document.source_type] = (document_counts[document.source_type] ?? 0) + 1;
      }
    }
    return {
      status: "ok",
      version: VERSION,
      revision: state2.revision,
      document_counts,
      batches: request.searches.map((item) => {
        const corpus = item.corpus === "transient" ? transient2 : state2;
        const preparedScores = item.corpus === "transient" ? transientScores : persistentScores;
        return {
          id: item.id,
          ...search(corpus, request.query, item.limit ?? 10, new Set(item.source_types ?? []), item.scope, preparedScores, terms2)
        };
      })
    };
  }
  if (request.op === "hybrid_fuse") {
    const hits = Array.isArray(request.hits) ? request.hits : [];
    const queryVector = Array.isArray(request.query_vector) ? request.query_vector : [];
    const vectors = request.vectors ?? {};
    const limit = Math.max(1, Math.min(Number(request.limit ?? 20), 200));
    const lexicalWeight = Number(request.lexical_weight ?? 0.45);
    const vectorWeight = Number(request.vector_weight ?? 0.55);
    const rrfK = Number(request.rrf_k ?? 60);
    const passthrough = (fusion, count, fallback, rows) => ({
      status: "ok",
      version: VERSION,
      fusion,
      vector_doc_count: count,
      vector_version: String(request.vector_version ?? ""),
      fallback,
      results: rows
    });
    if (!queryVector.length || Object.keys(vectors).length === 0) {
      return passthrough(
        "bm25",
        0,
        "embedding_cache_unavailable",
        hits.slice(0, limit).map((hit) => ({ chunk_id: String(hit.chunk_id), score: Number(hit.score || 0) }))
      );
    }
    const rrf = (rank, weight) => weight * ((rrfK + 1) / (rrfK + Math.max(1, rank)));
    const { fusedScores, vectorDocCount } = hybridFuseScores(hits, queryVector, vectors, lexicalWeight, vectorWeight, rrfK);
    if (fusedScores.size === 0) {
      const lexicalOnly = hits.map((hit, index) => ({
        chunk_id: String(hit.chunk_id),
        score: rrf(index + 1, lexicalWeight)
      }));
      lexicalOnly.sort((left, right) => right.score - left.score || (left.chunk_id < right.chunk_id ? -1 : 1));
      return passthrough("bm25", 0, "embedding_cache_unavailable", lexicalOnly.slice(0, limit));
    }
    const scored = hits.map((hit) => ({ chunk_id: String(hit.chunk_id), score: fusedScores.get(String(hit.chunk_id)) }));
    scored.sort((left, right) => right.score - left.score || (left.chunk_id < right.chunk_id ? -1 : 1));
    return passthrough("hybrid-rrf", vectorDocCount, null, scored.slice(0, limit));
  }
  if (request.op === "ping") {
    return {
      status: "ok",
      version: VERSION,
      revision: state2.revision,
      document_count: state2.documents.length,
      restore_error: state2.restoreError
    };
  }
  if (request.op === "tokenize") return { status: "ok", version: VERSION, tokens: tokenizeRaw(String(request.text ?? "")) };
  if (request.op === "adapt") {
    const batchKey = request.source_type === "file" ? "files" : request.source_type === "conversation" ? "conversations" : request.source_type;
    const batch = { [batchKey]: request.records };
    const documents = buildSourceDocuments(batch);
    return { status: "ok", version: VERSION, documents, document_count: documents.length };
  }
  if (request.op === "build_documents") {
    const documents = buildSourceDocuments(request.batch);
    return { status: "ok", version: VERSION, documents, document_count: documents.length };
  }
  if (request.op === "build_and_index") {
    const documents = buildSourceDocuments(request.batch);
    state2.restoreError = null;
    replaceInMemory(state2, request.revision, documents);
    await persist(state2);
    return {
      status: "ok",
      version: VERSION,
      revision: state2.revision,
      document_count: documents.length,
      input_digest: digest2(documents)
    };
  }
  if (request.op === "replace") {
    replaceInMemory(state2, request.revision ?? "", request.documents ?? []);
    state2.restoreError = null;
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
    const result = search(state2, request.query ?? "", request.limit ?? 10, allowedSources, request.scope);
    return { status: "ok", version: VERSION, revision: state2.revision, ...result };
  }
  if (request.op === "unified_search") {
    if ((request.revision ?? "") !== state2.revision) return { status: "error", code: "revision_mismatch", message: "TS sidecar revision \u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4" };
    const allowedSources = new Set(request.source_types ?? []);
    const searched = search(state2, request.query ?? "", 50, allowedSources, request.scope);
    const documentsById = new Map(state2.documents.map((document) => [document.id, document]));
    const output = selectUnifiedRecall(
      searched.results.flatMap((result) => {
        const document = documentsById.get(result.id);
        return document ? [{ result, document }] : [];
      }),
      { limit: request.limit ?? 5, maxChars: request.max_chars ?? 3e3 }
    );
    return { status: "ok", version: VERSION, revision: state2.revision, ...output };
  }
  if (request.op === "rank_candidates") {
    const output = rankCandidates(
      request.query ?? "",
      request.candidates ?? [],
      {
        limit: request.limit ?? 5,
        maxChars: request.max_chars ?? 3e3,
        maxPerSource: request.max_per_source ?? 3,
        maxPerParent: request.max_per_parent ?? 3,
        excludeContentHashes: request.exclude_content_hashes ?? [],
        selectionMode: request.selection_mode ?? "confidence"
      }
    );
    return {
      status: "ok",
      version: VERSION,
      selected: output.results,
      stats: output.diagnostics,
      input_digest: digest2(request.candidates ?? [])
    };
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
var transient = makeState();
await restore(state);
var input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let response;
  try {
    response = await handle(state, transient, JSON.parse(line));
  } catch (error) {
    response = { status: "error", code: "worker_failure", message: error instanceof Error ? error.message : "worker failure" };
  }
  process.stdout.write(`${JSON.stringify(response)}
`);
}
