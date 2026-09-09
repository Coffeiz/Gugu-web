import type { RagDocument } from "../../../../packages/contracts/src/rag.ts";

export type Posting = { ids: string[]; frequencies: number[] };

export type UnifiedRecallOptions = {
  limit?: number;
  maxChars?: number;
  maxPerSource?: number;
  maxPerParent?: number;
  excludeContentHashes?: string[];
  selectionMode?: "confidence" | "top_k";
  /** 评分版本；生产默认 confidence-v4，confidence-v1 仅作短期回滚。 */
  scoringVersion?: "confidence-v4" | "confidence-v1";
  /** 完整索引统计；生产排序禁止从当前候选池估算 IDF。 */
  corpusStatistics?: CorpusStatistics;
};

export type ScoringCorpus = {
  documents: RagDocument[];
  postings: Map<string, Posting>;
  lengths: Map<string, number>;
  docFreq: Map<string, number>;
  avgLength: number;
};

export type CorpusStatistics = {
  documentCount: number;
  averageLength: number;
  documentFrequency: ReadonlyMap<string, number>;
  source: "full_ts_index" | "combined_ts_index";
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
