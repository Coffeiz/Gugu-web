import { tokenizeRaw } from "../tokenizer.ts";
import type { ScoringCorpus } from "./types.ts";

export const K1 = 1.2;
export const B = 0.75;

export function tokenize(value: string): string[] {
  return tokenizeRaw(value);
}

export function termFrequency(items: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(item, (out.get(item) ?? 0) + 1);
  return out;
}

/** 只计算 BM25 词项分数；IDF 由当前语料的 docFreq 统计动态计算。 */
export function scoreTerms(corpus: ScoringCorpus, terms: Set<string>): Map<string, number> {
  const scores = new Map<string, number>();
  for (const term of terms) {
    const posting = corpus.postings.get(term);
    if (!posting) continue;
    const idf = Math.log(1 + (corpus.documents.length - posting.ids.length + 0.5) / (posting.ids.length + 0.5));
    posting.ids.forEach((id, position) => {
      const tf = posting.frequencies[position];
      const length = Math.max(1, corpus.lengths.get(id) ?? 0);
      const norm = tf + K1 * (1 - B + B * length / (corpus.avgLength || 1));
      scores.set(id, (scores.get(id) ?? 0) + idf * tf * (K1 + 1) / norm);
    });
  }
  return scores;
}
