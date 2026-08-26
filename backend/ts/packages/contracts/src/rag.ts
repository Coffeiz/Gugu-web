/** TypeScript RAG Worker 与业务桥接层共用的 canonical contract。 */

export const RAG_CONTRACT_VERSION = "rag-v1" as const;
export const RAG_WORKER_VERSION = "0.2.0" as const;

export type RagSourceType =
  | "memory"
  | "project"
  | "file"
  | "journal"
  | "canvas"
  | "conversation"
  | "knowledge";

export type RagScopeType = "owner" | "workspace" | "project" | "group" | "member" | "system";

export type RagDocument = {
  id: string;
  text: string;
  source_type: RagSourceType | string;
  scope_type: RagScopeType | string;
  scope_id: string;
  document_version: string;
};

export type RagSearchResult = {
  id: string;
  score: number;
  source_type: RagSourceType | string;
  document_version: string;
};

export type RagScoreCandidate = {
  id: string;
  source_type: RagSourceType | string;
  title?: string;
  summary?: string;
  content?: string;
  /** 输入候选可使用知识置信度字符串；score_filter 输出数值置信度。 */
  confidence?: string | number;
  normalized_score?: number;
  fused_score?: number;
  [key: string]: unknown;
};

export type RagScoreStats = {
  accepted_count: number;
  rejected_low_score: number;
  rejected_not_preferred: number;
  top_confidence: number;
  threshold: number;
  preferred_threshold: number;
  scoring_version: string;
};

export type RagRequest =
  | { op: "ping" }
  | { op: "tokenize"; text: string }
  | { op: "replace"; revision: string; documents: RagDocument[] }
  | { op: "patch"; revision: string; base_revision?: string; upserts: RagDocument[]; deletes: string[] }
  | { op: "search"; revision: string; query: string; limit?: number; source_types?: string[] }
  | { op: "score_filter"; query: string; candidates: RagScoreCandidate[]; limit?: number };

export type RagSuccessResponse =
  | { status: "ok"; version: string; revision: string; document_count: number }
  | { status: "ok"; version: string; tokens: string[] }
  | { status: "ok"; version: string; selected: RagScoreCandidate[]; stats: RagScoreStats; input_digest: string }
  | { status: "ok"; version: string; revision: string; results: RagSearchResult[] };

export type RagErrorResponse = {
  status: "error";
  code: "revision_mismatch" | "unknown_operation" | "worker_failure" | string;
  message: string;
};

export type RagResponse = RagSuccessResponse | RagErrorResponse;
