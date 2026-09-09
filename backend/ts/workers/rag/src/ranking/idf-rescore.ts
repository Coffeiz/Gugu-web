import type { RagDocument } from "../../../../packages/contracts/src/rag.ts";
import { B, K1, termFrequency, tokenize } from "./bm25.ts";
import { rankingText } from "./document-text.ts";
import type { CorpusStatistics } from "./types.ts";

export const IDF_EXPONENT = 1;
export const CONTRIBUTION_EXPONENT = 2;
export const MIN_QUERY_WEIGHT = 0.25;
export const MAX_QUERY_WEIGHT = 4;

export type TermContribution = {
  term: string;
  idf: number;
  queryWeight: number;
  termFrequency: number;
  weighted: number;
  nonlinear: number;
};

export type RescoreResult = {
  rankScore: number;
  matchedTerms: string[];
  contributions: TermContribution[];
  queryIdfBaseline: number;
  queryIdfTerms: Array<{ term: string; idf: number }>;
};

function idf(term: string, statistics: CorpusStatistics): number | null {
  const documentFrequency = statistics.documentFrequency.get(term);
  if (!statistics.documentCount || documentFrequency === undefined) return null;
  return Math.log(1 + (statistics.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function rescoreDocument(
  query: string,
  document: RagDocument,
  statistics: CorpusStatistics | undefined,
): RescoreResult | null {
  if (!statistics || statistics.documentCount <= 0) return null;
  const queryTerms = [...new Set(tokenize(query))];
  const indexedIdfs = queryTerms
    .map((term) => idf(term, statistics))
    .filter((value): value is number => value !== null);
  if (!indexedIdfs.length) return null;
  const baseline = indexedIdfs.reduce((sum, value) => sum + value, 0) / indexedIdfs.length;
  if (!(baseline > 0)) return null;
  const queryIdfTerms = queryTerms.flatMap((term) => {
    const termIdf = idf(term, statistics);
    return termIdf === null ? [] : [{ term, idf: termIdf }];
  });

  const frequencies = termFrequency(tokenize(rankingText(document)));
  const length = Math.max(1, [...frequencies.values()].reduce((sum, value) => sum + value, 0));
  const contributions: TermContribution[] = [];
  for (const term of queryTerms) {
    const termIdf = idf(term, statistics);
    const termFrequencyValue = frequencies.get(term) ?? 0;
    if (termIdf === null || !termFrequencyValue) continue;
    const queryWeight = clamp(
      Math.pow(termIdf / baseline, IDF_EXPONENT),
      MIN_QUERY_WEIGHT,
      MAX_QUERY_WEIGHT,
    );
    const norm = termFrequencyValue + K1 * (1 - B + B * length / (statistics.averageLength || 1));
    const bm25Term = termIdf * termFrequencyValue * (K1 + 1) / norm;
    const weighted = bm25Term * queryWeight;
    contributions.push({
      term,
      idf: termIdf,
      queryWeight,
      termFrequency: termFrequencyValue,
      weighted,
      nonlinear: Math.pow(weighted, CONTRIBUTION_EXPONENT),
    });
  }
  contributions.sort((left, right) =>
    right.nonlinear - left.nonlinear || left.term.localeCompare(right.term));
  return {
    rankScore: contributions.reduce((sum, item) => sum + item.nonlinear, 0),
    matchedTerms: contributions.map((item) => item.term),
    contributions,
    queryIdfBaseline: baseline,
    queryIdfTerms,
  };
}
