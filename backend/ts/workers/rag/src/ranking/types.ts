import type { RagDocument } from "../../../../packages/contracts/src/rag.ts";

export type UnifiedRecallOptions = {
  limit?: number;
  maxChars?: number;
  maxPerSource?: number;
  maxPerParent?: number;
  excludeContentHashes?: string[];
  selectionMode?: "confidence" | "top_k";
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
