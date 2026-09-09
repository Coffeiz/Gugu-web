import type { RagDocument } from "../../../../packages/contracts/src/rag.ts";

export type Posting = { ids: string[]; frequencies: number[] };

/** BM25 评分所需的只读语料视图；索引生命周期仍由 worker 负责。 */
export type ScoringCorpus = {
  documents: RagDocument[];
  postings: Map<string, Posting>;
  lengths: Map<string, number>;
  avgLength: number;
};
