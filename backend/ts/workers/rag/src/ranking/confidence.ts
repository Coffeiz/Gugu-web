import type { RagDocument, RagRankCandidate } from "../../../../packages/contracts/src/rag.ts";
import { tokenize } from "./bm25.ts";

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
  const text = `${document.title ?? ""}\n${document.summary ?? ""}\n${document.text ?? ""}`;
  const compactQuery = String(query || "").replace(/\s+/gu, "").toLocaleLowerCase();
  const compactText = text.replace(/\s+/gu, "").toLocaleLowerCase();
  if (compactQuery.length >= 2 && compactText.includes(compactQuery)) return 1;
  const documentTerms = new Set(tokenize(text));
  let matched = 0;
  for (const token of meaningful) if (documentTerms.has(token)) matched += 1;
  return matched / meaningful.size;
}

export function confidence(candidate: RagRankCandidate, fused: number, query: string): { value: number; sourceQuality: number } {
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
