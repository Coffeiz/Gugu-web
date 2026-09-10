import type { RagCitation, RagRankCandidate, RagRankDiagnostics, RagRankResult } from "../../../../packages/contracts/src/rag.ts";
import { confidenceV1, confidenceV4, queryMatch, SCORING_THRESHOLDS, sourceQualityV4, V4_LOW_SCORE_THRESHOLD, type ScoringVersion } from "./confidence.ts";
import { rescoreDocument } from "./idf-rescore.ts";
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
  const version: ScoringVersion = options.scoringVersion ?? "confidence-v4";
  const thresholds = SCORING_THRESHOLDS[version];
  const excluded = new Set(options.excludeContentHashes ?? []);
  const eligible = candidates.filter((candidate) =>
    !contentHashes(candidate.document).some((hash) => excluded.has(hash))
  );
  const normalized = normalizeBySource(eligible);
  let scored: ScoredCandidate[] = eligible.map((candidate) => {
    const normalizedScore = normalized.get(candidate.id) ?? 0;
    const fused = candidate.fused_score !== undefined && candidate.fused_score !== null
      ? Number(candidate.fused_score)
      : candidate.fusion === "hybrid-rrf"
        ? Number(candidate.raw_score || 0)
        : normalizedScore;
    const rescore = rescoreDocument(query, candidate.document, options.corpusStatistics);
    const rankScore = rescore?.rankScore ?? fused;
    let value: number;
    let sourceQuality: number;
    let match: number;
    if (version === "confidence-v4") {
      match = Math.min(1, queryMatch(query, candidate.document));
      sourceQuality = sourceQualityV4(candidate.source_type);
      value = confidenceV4(rankScore, match, sourceQuality);
      // 无命中保护（PRD §3.5）：零命中候选不得凭来源质量进入首选集合。
      if (match <= 0) value = Math.min(value, thresholds.low - 0.01);
    } else {
      ({ value, sourceQuality, match } = confidenceV1(candidate, fused, query));
    }
    return {
      candidate,
      normalizedScore,
      fused,
      rankScore,
      rescore,
      value,
      sourceQuality,
      match,
    };
  });
  // confidence-v4 主排序：分数已含来源质量与词法归一化（rank_score 为 p=1.5
  // 非线性词法分，天然是池内可比的词法主信号），rank_score 仅作同分决胜。
  // v4 的词法归一化必须回写：band 过滤、rejected 统计和 top_confidence 都
  // 以归一化后的分数为准，否则原始 rank_score（可达数十）会漏进交付。
  if (version === "confidence-v4") {
    scored = normalizeV4Lexical(scored);
  }
  const orderedScored = scored;
  const finalOrdered = [...orderedScored].sort((left, right) =>
    right.value - left.value
    || right.rankScore - left.rankScore
    || right.fused - left.fused
    || (SOURCE_PRIORITY[left.candidate.source_type] ?? 100) - (SOURCE_PRIORITY[right.candidate.source_type] ?? 100)
    || String(right.candidate.document.updated_at ?? "").localeCompare(String(left.candidate.document.updated_at ?? ""))
    || String(left.candidate.document.document_version).localeCompare(String(right.candidate.document.document_version))
    || String(left.candidate.document.id).localeCompare(String(right.candidate.document.id))
  );
  const selectionMode = options.selectionMode ?? "confidence";
  const preferred = finalOrdered.filter((item) => item.value >= thresholds.preferred);
  const fallback = finalOrdered.filter((item) => item.value >= thresholds.low && item.value < thresholds.preferred);
  const confidenceSelected = (selectionMode === "top_k"
    ? finalOrdered
    : (preferred.length ? preferred : fallback))
    .slice(0, Math.max(1, Number(options.limit ?? 5)));
  const selectedIds = new Set(confidenceSelected.map((item) => item.candidate.id));
  const ordered = confidenceSelected;
  const unified = selectUnifiedRecall(
    // 交付与预算顺序保持冻结契约：fused（归一化词法融合分）降序 + id 升序；
    // confidence 只决定入选集合（band/限额），语义混合通过 v4 confidence 生效。
    ordered.map((item) => ({ result: { id: item.candidate.id, score: item.rankScore, source_type: item.candidate.source_type, document_version: item.candidate.document.document_version }, document: { ...item.candidate.document, id: item.candidate.id, text: item.candidate.document.text } })),
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
      text: document.context_text || document.text,
      confidence: item?.value ?? 0,
      source_quality: item?.sourceQuality ?? 0,
      query_match: item?.match ?? 0,
      normalized_score: item?.normalizedScore ?? 0,
      fused_score: item?.fused ?? 0,
      semantic_norm: item?.semanticNorm,
      rank_score: item?.rankScore ?? item?.fused ?? 0,
      query_idf_baseline: item?.rescore?.queryIdfBaseline,
      query_idf_terms: item?.rescore?.queryIdfTerms,
      rank_contributions: item?.rescore?.contributions.map((contribution) => ({
        term: contribution.term,
        idf: contribution.idf,
        query_weight: contribution.queryWeight,
        term_frequency: contribution.termFrequency,
        weighted: contribution.weighted,
        nonlinear: contribution.nonlinear,
      })),
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
    rejected_low_score: selectionMode === "confidence" ? scored.filter((item) => item.value < thresholds.low).length : 0,
    rejected_not_preferred: selectionMode === "confidence"
      ? scored.filter((item) => preferred.length > 0 && item.value >= thresholds.low && !selectedIds.has(item.candidate.id)).length
      : 0,
    top_confidence: Math.max(0, ...scored.map((item) => item.value)),
    threshold: thresholds.low,
    preferred_threshold: thresholds.preferred,
    selection_mode: selectionMode,
    scoring_version: version,
    rescore_version: options.corpusStatistics ? "idf-nonlinear-v2" : "disabled",
    idf_source: options.corpusStatistics?.source ?? "none",
    contribution_exponent: options.corpusStatistics ? 1.5 : null,
    source_diagnostics: sourceDiagnostics,
    elapsed_ms: Math.round(performance.now() - started),
  } satisfies RagRankDiagnostics;
  return { results, diagnostics: stats };
}

/**
 * v4 的词法归一化：rank_score / 池内最高分。与 v1 的来源内归一化不同，
 * v4 跨来源统一归一化，保证乘法公式的分数上界语义（PRD §6.4）。
 * 语义混合镜像 Python 诊断探针 apply_confidence_v4：候选池内
 * `semantic_norm = cosine / 池最大 cosine`（池最大 ≤ 0 时整体退纯词法，
 * 归一后为负的候选钳到 0 视为无语义），有语义的候选把 v4 的词法位替换成
 * `0.45*lexical_norm + 0.55*semantic_norm`，无语义候选保持纯词法。
 */
type ScoredCandidate = {
  candidate: RagRankCandidate;
  normalizedScore: number;
  fused: number;
  rankScore: number;
  rescore: ReturnType<typeof rescoreDocument>;
  value: number;
  sourceQuality: number;
  match: number;
  semanticNorm?: number;
};

function normalizeV4Lexical(scored: ScoredCandidate[]): ScoredCandidate[] {
  const topLexical = Math.max(0, ...scored.map((item) => item.rankScore));
  if (topLexical <= 0) return scored;
  let topSemantic = 0;
  for (const item of scored) {
    const semantic = item.candidate.semantic_score;
    if (semantic !== undefined && semantic > topSemantic) topSemantic = semantic;
  }
  const hasSemantic = topSemantic > 0;
  return scored.map((item) => {
    const lexicalNorm = Math.min(1, item.rankScore / topLexical);
    let semanticNorm: number | undefined;
    if (hasSemantic && item.candidate.semantic_score !== undefined) {
      const normalized = item.candidate.semantic_score / topSemantic;
      if (normalized > 0) {
        semanticNorm = Math.round(Math.min(1, normalized) * 1e6) / 1e6;
      }
    }
    const fusedNorm = semanticNorm !== undefined
      ? 0.45 * lexicalNorm + 0.55 * semanticNorm
      : lexicalNorm;
    let value = confidenceV4(fusedNorm, item.match, item.sourceQuality);
    if (item.match <= 0) value = Math.min(value, V4_LOW_SCORE_THRESHOLD - 0.01);
    return { ...item, value, semanticNorm };
  });
}
