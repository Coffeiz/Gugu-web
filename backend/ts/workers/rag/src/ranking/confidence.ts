import type { RagDocument, RagRankCandidate } from "../../../../packages/contracts/src/rag.ts";
import { tokenize } from "./bm25.ts";
import { rankingText } from "./document-text.ts";

// 当前生产评分：confidence-v4（docs/prds/PRD-TS-RAG-0.4.0-算法设计.md §6.6/§6.7）。
// confidence-v1 保留为短期回滚开关（UnifiedRecallOptions.scoringVersion），
// 不再参与默认排序；版本号只区分公式口径，不拆分文件。

// ---- confidence-v4（生产默认）----
// 乘法公式天然有界：上界 = 来源质量（knowledge 最高 1.0），无命中候选受
// lexical_norm 与乘法自然压缩，不设额外硬保护（PRD §12 开放项跟踪）。

export const V4_LEXICAL_WEIGHT = 0.75;
export const V4_QUERY_MATCH_WEIGHT = 0.25;
export const V4_PREFERRED_THRESHOLD = 0.55;
export const V4_LOW_SCORE_THRESHOLD = 0.35;
export const V4_SOURCE_QUALITY_VERSION = "v4-20260910";

export const SOURCE_QUALITY_V4: Record<string, number> = {
  knowledge: 1.0,
  memory: 0.8,
  project: 0.8,
  file: 0.8,
  journal: 0.8,
  note: 0.8,
  calendar: 0.8,
  canvas: 0.6,
  conversation: 0.6,
};
export const V4_UNKNOWN_SOURCE_QUALITY = 0.6;

export function sourceQualityV4(sourceType: string): number {
  return SOURCE_QUALITY_V4[sourceType] ?? V4_UNKNOWN_SOURCE_QUALITY;
}

export function confidenceV4(
  lexicalNorm: number,
  match: number,
  sourceQuality: number,
): number {
  // 无 embedding 时 retrieval_norm 就是词法归一化；semantic 融合待数据校准。
  return (V4_LEXICAL_WEIGHT * lexicalNorm + V4_QUERY_MATCH_WEIGHT * match) * sourceQuality;
}

// ---- confidence-v1（回滚开关，不再默认）----

export const SOURCE_QUALITY: Record<string, number> = {
  memory: 0.8,
  project: 0.9,
  file: 0.8,
  canvas: 0.75,
  conversation: 0.65,
  journal: 0.7,
  knowledge: 0.8,
};

export function queryMatch(query: string, document: RagDocument): number {
  // Python 的 re.UNICODE 会把中文视为词字符，不能用 JS 的 \W 直接等价替换。
  const meaningful = new Set(tokenize(query).filter((token) => !/^[\d\p{P}\p{S}_]+$/u.test(token)));
  if (!meaningful.size) return 0;
  const text = rankingText(document);
  const compactQuery = String(query || "").replace(/\s+/gu, "").toLocaleLowerCase();
  const compactText = text.replace(/\s+/gu, "").toLocaleLowerCase();
  if (compactQuery.length >= 2 && compactText.includes(compactQuery)) return 1;
  const documentTerms = new Set(tokenize(text));
  let matched = 0;
  for (const token of meaningful) if (documentTerms.has(token)) matched += 1;
  return matched / meaningful.size;
}

export function confidenceV1(candidate: RagRankCandidate, fused: number, query: string): { value: number; sourceQuality: number; match: number } {
  let sourceQuality = SOURCE_QUALITY[candidate.source_type] ?? 0.7;
  if (candidate.source_type === "knowledge") {
    const weight = { confirmed: 1, probable: 0.85, unverified: 0.65, conflict: 0.35 }[String(candidate.document.metadata?.confidence ?? "")] ?? 0.65;
    sourceQuality *= weight;
  }
  const match = Math.min(1, queryMatch(query, candidate.document));
  let value = 0.55 * fused + 0.25 * match + 0.20 * sourceQuality;
  if (match <= 0) value = Math.min(value, 0.35 - 0.01);
  return { value: Math.min(1, Math.max(0, value)), sourceQuality, match };
}

export const SCORING_VERSIONS = ["confidence-v4", "confidence-v1"] as const;
export type ScoringVersion = (typeof SCORING_VERSIONS)[number];

export const SCORING_THRESHOLDS: Record<ScoringVersion, { preferred: number; low: number }> = {
  "confidence-v4": { preferred: V4_PREFERRED_THRESHOLD, low: V4_LOW_SCORE_THRESHOLD },
  "confidence-v1": { preferred: 0.55, low: 0.35 },
};
