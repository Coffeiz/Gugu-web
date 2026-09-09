import type { RagRankCandidate } from "../../../../packages/contracts/src/rag.ts";

export function normalizeBySource(candidates: RagRankCandidate[]): Map<string, number> {
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
