import type { RagCitation, RagRankCandidate, RagRankDiagnostics, RagRankResult } from "../../../../packages/contracts/src/rag.ts";
import { confidence } from "./confidence.ts";
import { normalizeBySource } from "./normalize.ts";
import { citation, contentHashes, contentKey } from "./helpers.ts";
import { selectUnifiedRecall } from "./select-recall.ts";
import type { UnifiedRecallOptions } from "./types.ts";

const SOURCE_PRIORITY: Record<string, number> = {
  memory: 0,
  project: 10,
  file: 20,
  calendar: 30,
  scheduled_task: 35,
  journal: 30,
  canvas: 40,
  conversation: 50,
};

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
    const fused = candidate.fused_score !== undefined && candidate.fused_score !== null
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
  const selectionMode = options.selectionMode ?? "confidence";
  const preferred = orderedScored.filter((item) => item.value >= 0.55);
  const fallback = orderedScored.filter((item) => item.value >= 0.35 && item.value < 0.55);
  const confidenceSelected = (selectionMode === "top_k"
    ? orderedScored
    : (preferred.length ? preferred : fallback))
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
    rejected_low_score: selectionMode === "confidence" ? scored.filter((item) => item.value < 0.35).length : 0,
    rejected_not_preferred: selectionMode === "confidence"
      ? scored.filter((item) => preferred.length > 0 && item.value >= 0.35 && !selectedIds.has(item.candidate.id)).length
      : 0,
    top_confidence: Math.max(0, ...scored.map((item) => item.value)),
    threshold: 0.35,
    preferred_threshold: 0.55,
    selection_mode: selectionMode,
    scoring_version: "confidence-v1",
    source_diagnostics: sourceDiagnostics,
    elapsed_ms: Math.round(performance.now() - started),
  } satisfies RagRankDiagnostics;
  return { results, diagnostics: stats };
}
