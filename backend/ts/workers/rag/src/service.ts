import { createHash } from "node:crypto";
import type { RagCitation, RagDocument, RagRankCandidate, RagRankDiagnostics, RagRankResult, RagSearchResult } from "../../../packages/contracts/src/rag.ts";
import { tokenizeRaw } from "./tokenizer.ts";

export type UnifiedRecallOptions = {
  limit?: number;
  maxChars?: number;
  maxPerSource?: number;
  maxPerParent?: number;
  excludeContentHashes?: string[];
};

export type UnifiedRecallDiagnostics = {
  candidate_count: number;
  accepted_count: number;
  rejected_duplicate: number;
  rejected_parent: number;
  rejected_source: number;
  rejected_similarity: number;
  output_chars: number;
};

export type UnifiedRecallOutput = {
  results: RagDocument[];
  has_more: boolean;
  diagnostics: UnifiedRecallDiagnostics;
};

function compact(value: string): string {
  return String(value || "").replace(/\s+/gu, "").trim().toLocaleLowerCase();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function contentHashes(value: string): string[] {
  const text = String(value || "").trim();
  return [digest(text), digest(text.replace(/\s+/gu, ""))];
}

function contentKey(value: string): string {
  return digest(compact(value));
}

function citation(document: RagDocument): RagCitation {
  const metadata = document.metadata ?? {};
  const sourceId = String(metadata.source_id ?? document.parent_id ?? document.id);
  const chunkId = `${document.parent_id ?? document.id}:${document.document_version}:${document.chunk_index ?? 0}`;
  return {
    source_type: document.source_type,
    source_id: sourceId,
    title: String(document.title ?? "未命名来源"),
    chunk_id: chunkId,
    version: document.document_version,
    ...(document.updated_at ? { updated_at: document.updated_at } : {}),
  };
}

function tokenSet(document: RagDocument): Set<string> {
  return new Set(terms(document.text));
}

function terms(value: string): string[] {
  return tokenizeRaw(value);
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}

const SOURCE_QUALITY: Record<string, number> = {
  memory: 0.8,
  project: 0.9,
  file: 0.8,
  canvas: 0.75,
  conversation: 0.65,
  journal: 0.7,
  knowledge: 0.8,
};
const SOURCE_PRIORITY: Record<string, number> = {
  memory: 0,
  project: 10,
  file: 20,
  journal: 30,
  canvas: 40,
  conversation: 50,
};

function normalizeBySource(candidates: RagRankCandidate[]): Map<string, number> {
  const grouped = new Map<string, RagRankCandidate[]>();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.source_type) ?? [];
    group.push(candidate);
    grouped.set(candidate.source_type, group);
  }
  const normalized = new Map<string, number>();
  for (const group of grouped.values()) {
    const scores = group.map((candidate) => Number(candidate.raw_score || 0));
    const low = Math.min(...scores);
    const high = Math.max(...scores);
    for (const candidate of group) {
      const score = Number(candidate.raw_score || 0);
      normalized.set(candidate.id, high <= low
        ? Math.max(0, score) / (1 + Math.max(0, score))
        : (score - low) / (high - low));
    }
  }
  return normalized;
}

function queryMatch(query: string, document: RagDocument): number {
  // Python 的 re.UNICODE 会把中文视为词字符，不能用 JS 的 \W 直接等价替换。
  const meaningful = new Set(terms(query).filter((token) => !/^[\d\p{P}\p{S}_]+$/u.test(token)));
  if (!meaningful.size) return 0;
  const text = `${document.title ?? ""}\n${document.summary ?? ""}\n${document.text ?? ""}`;
  const compactQuery = String(query || "").replace(/\s+/gu, "").toLocaleLowerCase();
  const compactText = text.replace(/\s+/gu, "").toLocaleLowerCase();
  if (compactQuery.length >= 2 && compactText.includes(compactQuery)) return 1;
  const documentTerms = new Set(terms(text));
  let matched = 0;
  for (const token of meaningful) if (documentTerms.has(token)) matched += 1;
  return matched / meaningful.size;
}

function confidence(candidate: RagRankCandidate, fused: number, query: string): { value: number; sourceQuality: number } {
  let sourceQuality = SOURCE_QUALITY[candidate.source_type] ?? 0.7;
  if (candidate.source_type === "knowledge") {
    const weight = { confirmed: 1, probable: 0.85, unverified: 0.65, conflict: 0.35 }[String(candidate.document.metadata?.confidence ?? "")] ?? 0.65;
    sourceQuality *= weight;
  }
  const match = Math.min(1, queryMatch(query, candidate.document));
  let value = 0.55 * fused + 0.25 * match + 0.20 * sourceQuality;
  if (match <= 0) value = Math.min(value, 0.35 - 0.01);
  return { value: Math.min(1, Math.max(0, value)), sourceQuality };
}

/** 完整执行 Python 旧流水线中的归一化、置信度过滤和统一预算。 */
export function rankCandidates(
  query: string,
  candidates: RagRankCandidate[],
  options: UnifiedRecallOptions = {},
): { results: RagRankResult[]; diagnostics: RagRankDiagnostics } {
  const started = performance.now();
  const excluded = new Set(options.excludeContentHashes ?? []);
  const eligible = candidates.filter((candidate) =>
    !contentHashes(candidate.document.text).some((hash) => excluded.has(hash))
  );
  const normalized = normalizeBySource(eligible);
  const scored = eligible.map((candidate) => {
    const normalizedScore = normalized.get(candidate.id) ?? 0;
    const fused = candidate.fused_score !== undefined
      ? Number(candidate.fused_score)
      : candidate.fusion === "hybrid-rrf"
        ? Number(candidate.raw_score || 0)
        : normalizedScore;
    const quality = confidence(candidate, fused, query);
    return { candidate, normalizedScore, fused, ...quality };
  });
  const orderedScored = [...scored].sort((left, right) =>
    right.fused - left.fused
    || (SOURCE_PRIORITY[left.candidate.source_type] ?? 100) - (SOURCE_PRIORITY[right.candidate.source_type] ?? 100)
    || String(right.candidate.document.updated_at ?? "").localeCompare(String(left.candidate.document.updated_at ?? ""))
    || String(left.candidate.document.document_version).localeCompare(String(right.candidate.document.document_version))
    || String(left.candidate.document.id).localeCompare(String(right.candidate.document.id))
  );
  const preferred = orderedScored.filter((item) => item.value >= 0.55);
  const fallback = orderedScored.filter((item) => item.value >= 0.35 && item.value < 0.55);
  const confidenceSelected = (preferred.length ? preferred : fallback)
    .slice(0, Math.max(1, Number(options.limit ?? 5)));
  const selectedIds = new Set(confidenceSelected.map((item) => item.candidate.id));
  const ordered = confidenceSelected;
  const unified = selectUnifiedRecall(
    ordered.map((item) => ({ result: { id: item.candidate.id, score: item.fused, source_type: item.candidate.source_type, document_version: item.candidate.document.document_version }, document: { ...item.candidate.document, id: item.candidate.id, text: item.candidate.document.text } })),
    options,
  );
  const byId = new Map(ordered.map((item) => [item.candidate.id, item]));
  const citationsByContent = new Map<string, RagCitation[]>();
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
      citations,
    };
  });
  const sourceDiagnostics: NonNullable<RagRankDiagnostics["source_diagnostics"]> = {};
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
    rejected_low_score: scored.filter((item) => item.value < 0.35).length,
    rejected_not_preferred: scored.filter((item) => preferred.length > 0 && item.value >= 0.35 && !selectedIds.has(item.candidate.id)).length,
    top_confidence: Math.max(0, ...scored.map((item) => item.value)),
    threshold: 0.35,
    preferred_threshold: 0.55,
    scoring_version: "confidence-v1",
    source_diagnostics: sourceDiagnostics,
    elapsed_ms: Math.round(performance.now() - started),
  } satisfies RagRankDiagnostics;
  return { results, diagnostics: stats };
}

export function selectUnifiedRecall(
  candidates: Array<{ result: RagSearchResult; document: RagDocument }>,
  options: UnifiedRecallOptions = {},
): UnifiedRecallOutput {
  const limit = Math.max(1, Math.min(Number(options.limit ?? 5), 50));
  const maxChars = Math.max(1, Number(options.maxChars ?? 3000));
  const maxPerSource = Math.max(1, Number(options.maxPerSource ?? 3));
  const maxPerParent = Math.max(1, Number(options.maxPerParent ?? 3));
  const selected: RagDocument[] = [];
  const hashes = new Set<string>();
  const parentCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const selectedTokens: Set<string>[] = [];
  let outputChars = 0;
  let rejectedDuplicate = 0;
  let rejectedParent = 0;
  let rejectedSource = 0;
  let rejectedSimilarity = 0;

  const ordered = [...candidates].sort(
    (left, right) => right.result.score - left.result.score || left.result.id.localeCompare(right.result.id),
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
    if ((parentCounts.get(parent) ?? 0) >= maxPerParent) {
      rejectedParent += 1;
      continue;
    }
    if ((sourceCounts.get(document.source_type) ?? 0) >= maxPerSource) {
      rejectedSource += 1;
      continue;
    }
    const tokens = tokenSet(document);
    if (selectedTokens.some((previous) => similarity(tokens, previous) >= 0.85)) {
      rejectedSimilarity += 1;
      continue;
    }
    const remaining = maxChars - outputChars;
    if (remaining <= 0) break;
    const next = text.length > remaining ? { ...document, text: text.slice(0, remaining).trimEnd() } : document;
    if (!next.text) continue;
    selected.push(next);
    hashes.add(hash);
    selectedTokens.push(tokens);
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
      output_chars: outputChars,
    },
  };
}
