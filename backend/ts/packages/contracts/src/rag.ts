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
  | "knowledge"
  | "note"
  | "calendar"
  | "scheduled_task";

export type RagScopeType = "owner" | "workspace" | "project" | "folder" | "group" | "member" | "system";

export type RagDocument = {
  id: string;
  text: string;
  source_type: RagSourceType | string;
  title?: string;
  summary?: string;
  platform?: string;
  bot_id?: string;
  group_id?: string;
  scope_type: RagScopeType | string;
  scope_id: string;
  document_version: string;
  parent_id?: string;
  chunk_index?: number;
  chunk_count?: number;
  updated_at?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

/** 业务层向来源适配器提交的统一源记录；不包含原始二进制或内部存储路径。 */
export type RagSourceRecord = {
  id: string | number;
  source_type: RagSourceType | string;
  scope: RagSearchScope;
  title: string;
  summary?: string;
  content: string;
  document_version: string;
  updated_at?: string;
  metadata?: Record<string, string | number | boolean | null>;
  /** 专用来源适配器可携带各自的已授权字段；worker 不把未声明字段写入索引。 */
  [key: string]: unknown;
};

export type RagSourceBatch = {
  /** 各来源使用自己的 canonical record；具体字段由来源适配器校验。 */
  memory?: Record<string, unknown>[];
  project?: Record<string, unknown>[];
  files?: Record<string, unknown>[];
  note?: Record<string, unknown>[];
  canvas?: Record<string, unknown>[];
  calendar?: Record<string, unknown>[];
  scheduled_task?: Record<string, unknown>[];
  conversations?: Record<string, unknown>[];
  knowledge?: Record<string, unknown>[];
};

export type RagSearchResult = {
  id: string;
  score: number;
  source_type: RagSourceType | string;
  document_version: string;
};

export type RagSearchDiagnostics = {
  candidate_count: number;
  eligible_count: number;
  filtered_count: number;
  source_filter_applied: boolean;
  scope_filter_applied: boolean;
  elapsed_ms: number;
};

export type RagSearchScope = {
  platform?: string;
  bot_id?: string;
  group_id?: string;
  scope_type?: string;
  scope_id?: string;
};

/** Python 业务层提交给 TS 的完整候选流水线输入。 */
export type RagRankCandidate = {
  id: string;
  source_type: string;
  raw_score: number;
  rank: number;
  fusion?: "bm25" | "hybrid-rrf";
  fused_score?: number;
  document: RagDocument;
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

export type RagUnifiedDiagnostics = {
  candidate_count: number;
  accepted_count: number;
  rejected_duplicate: number;
  rejected_parent: number;
  rejected_source: number;
  rejected_similarity: number;
  output_chars: number;
};

export type RagRankDiagnostics = RagUnifiedDiagnostics & RagScoreStats & {
  elapsed_ms: number;
  source_diagnostics?: Record<string, {
    candidate_count: number;
    eligible_count: number;
    accepted_count: number;
  }>;
};

export type RagCitation = {
  source_type: string;
  source_id: string;
  title: string;
  chunk_id: string;
  version: string;
  updated_at?: string;
};

export type RagRankResult = {
  id: string;
  text: string;
  confidence: number;
  source_quality: number;
  normalized_score: number;
  fused_score: number;
  citation: RagCitation;
  citations: RagCitation[];
};

export type RagRequest =
  | { op: "ping" }
  | { op: "tokenize"; text: string }
  | { op: "adapt"; source_type: RagSourceType | string; records: Record<string, unknown>[] }
  | { op: "build_documents"; batch: RagSourceBatch }
  | { op: "build_and_index"; revision: string; batch: RagSourceBatch }
  | { op: "replace"; revision: string; documents: RagDocument[] }
  | { op: "patch"; revision: string; base_revision?: string; upserts: RagDocument[]; deletes: string[] }
  | { op: "search"; revision: string; query: string; limit?: number; source_types?: string[]; scope?: RagSearchScope }
  | { op: "unified_search"; revision: string; query: string; limit?: number; source_types?: string[]; scope?: RagSearchScope; max_chars?: number }
  | { op: "rank_candidates"; query: string; candidates: RagRankCandidate[]; limit?: number; max_chars?: number; max_per_source?: number; max_per_parent?: number; exclude_content_hashes?: string[] };

export type RagSuccessResponse =
  | { status: "ok"; version: string; revision: string; document_count: number }
  | { status: "ok"; version: string; tokens: string[] }
  | { status: "ok"; version: string; documents: RagDocument[]; document_count: number }
  | { status: "ok"; version: string; selected: RagRankResult[]; stats: RagRankDiagnostics; input_digest: string }
  | { status: "ok"; version: string; revision: string; results: RagSearchResult[]; diagnostics: RagSearchDiagnostics }
  | { status: "ok"; version: string; revision: string; results: RagDocument[]; has_more: boolean; diagnostics: RagUnifiedDiagnostics };

export type RagErrorResponse = {
  status: "error";
  code: "revision_mismatch" | "unknown_operation" | "worker_failure" | string;
  message: string;
};

export type RagResponse = RagSuccessResponse | RagErrorResponse;
