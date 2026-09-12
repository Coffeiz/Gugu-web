import type { RagDocument, RagSourceRecord } from "../../contracts/src/rag.ts";

export type DataScope = {
  type: "owner" | "group" | "member";
  id: string;
  platform?: string;
  botId?: string;
  groupId?: string;
  /** Python 边界层已校验的 scope 所属用户；worker 仍需与绑定 owner 比较。 */
  ownerId?: string;
};

/** 所有 TS 数据读取都必须带 owner；scope 只允许收窄读取范围。 */
export type DataAccessContext = {
  ownerId: string;
  scope?: DataScope;
};

export function assertOwnerScope(context: DataAccessContext): string {
  const ownerId = context.ownerId.trim();
  if (!ownerId) throw new DataRuntimeError("invalid_context", "Data Runtime 缺少 ownerId");
  if (context.scope && (context.scope.type !== "owner" || context.scope.id !== ownerId)) {
    throw new DataRuntimeError("scope_forbidden", "Data Runtime 拒绝未实现的读取范围");
  }
  return ownerId;
}

export type ReadOptions = {
  limit?: number;
  afterId?: number;
};

/** 文件正文和用户私有记忆的唯一存储读取边界。实现方负责 ownership 校验。 */
export type StorageReader = {
  readText(input: {
    ownerId: string;
    key: string;
    maxChars: number;
  }): Promise<string | null>;
};

export type DataReadResult<T> = {
  records: T[];
  nextAfterId?: number;
};

export type CachedReadResult<T> = DataReadResult<T> & {
  cache: {
    hit: boolean;
    reason: "miss" | "hit" | "revision-changed" | "expired";
    key: string;
    revision: string;
  };
};

export type DataErrorCode =
  | "invalid_context"
  | "scope_forbidden"
  | "invalid_cursor"
  | "database_unavailable"
  | "read_failed";

export class DataRuntimeError extends Error {
  // strip-only 兼容：参数属性语法见 runtime.ts 同款说明。
  readonly code: DataErrorCode;

  constructor(
    code: DataErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.name = "DataRuntimeError";
  }
}

export type ProjectRecord = RagSourceRecord & {
  source_type: "project";
  id: number;
};

export type FileMetadataRecord = RagSourceRecord & {
  source_type: "file";
  id: number;
  display_name: string;
  ext?: string;
  mime_type?: string;
  project_id?: number | null;
  folder_id?: number | null;
  size_bytes: number;
};

export type ConversationRecord = RagSourceRecord & {
  source_type: "conversation";
  id: number;
  session_id: number;
  message_id: number;
  role: "user" | "assistant";
  context_before?: string;
  context_after?: string;
};

export type KnowledgeRecord = RagSourceRecord & {
  source_type: "knowledge";
  id: string;
};

export type MemoryRecord = RagSourceRecord & {
  source_type: "memory";
  id: string;
  storage_key: string;
};

export type CanvasRecord = RagSourceRecord & {
  source_type: "canvas";
  id: string;
  canvas_id: number;
  node_id: number;
};

export type DataDocument = {
  id: string;
  source_type: string;
  scope_type: string;
  scope_id: string;
  parent_id: string;
  title: string;
  summary?: string;
  document_version: string;
  updated_at?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type RagIndexSnapshot = {
  documents: RagDocument[];
};

export type MemoryScopeState = {
  revision: string;
  tombstoned: boolean;
};

export type RagCursor = { ts: string; id: number };

export type RagIndexDelta = {
  documents: RagDocument[];
  /** 软删墓碑行对应的 worker 文档键（增量删除） */
  deleteIds: string[];
  /** 本批最后一行的 (indexed_at, id)；无更多行时为 null */
  cursor: RagCursor | null;
  hasMore: boolean;
  probe: { stage_ms: Record<string, number>; counts: Record<string, number> };
};

export type DataChunk = DataDocument & {
  chunk_id: string;
  chunk_index: number;
  chunk_count: number;
  text: string;
  digest: string;
};

export type ChunkPatch = {
  upserts: DataChunk[];
  deletes: string[];
};
