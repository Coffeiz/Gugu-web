import type { Sql } from "postgres";
import type { RagSearchScope, RagSourceRecord } from "../../contracts/src/rag.ts";
import { assertOwnerScope, DataRuntimeError } from "./contracts.ts";
import { DataRuntimeCache } from "./cache.ts";
import type { DataRuntimeInvalidationEvent } from "./invalidation.ts";
import type {
  CachedReadResult,
  ConversationRecord,
  DataAccessContext,
  DataReadResult,
  FileMetadataRecord,
  CanvasRecord,
  KnowledgeRecord,
  MemoryRecord,
  ProjectRecord,
  ReadOptions,
  StorageReader,
} from "./contracts.ts";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2_000;

function limitOf(value?: number): number {
  const requested = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isFinite(requested)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(requested)));
}

function afterIdOf(value?: number): number {
  const cursor = Number(value ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new DataRuntimeError("invalid_cursor", "Data Runtime 收到无效读取游标");
  }
  return cursor;
}

function ownerScope(ownerId: string): RagSearchScope {
  return { scope_type: "owner", scope_id: ownerId };
}

/** 统一只读数据入口；不负责写入、工具权限或 Agent prompt 组装。 */
export class DataRuntime {
  private readonly cache = new DataRuntimeCache<DataReadResult<unknown>>();
  private closed = false;

  constructor(private readonly sql: Sql) {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.sql.end({ timeout: 5 });
  }

  async readCached<T>(
    key: string,
    revision: string,
    loader: () => Promise<DataReadResult<T>>,
  ): Promise<DataReadResult<T>> {
    const result = await this.readCachedWithStatus(key, revision, loader);
    return result.value;
  }

  async readCachedWithStatus<T>(
    key: string,
    revision: string,
    loader: () => Promise<DataReadResult<T>>,
  ): Promise<{ value: DataReadResult<T>; hit: boolean; reason: "miss" | "hit" | "revision-changed" | "expired" }> {
    if (!key.trim()) throw new DataRuntimeError("invalid_context", "Data Runtime 缺少缓存键");
    if (!revision.trim()) throw new DataRuntimeError("invalid_context", "Data Runtime 缺少 revision");
    const cached = this.cache.get(key, revision);
    if (cached.hit) return { value: cached.value as DataReadResult<T>, hit: true, reason: "hit" };
    try {
      const result = await loader();
      this.cache.set(key, revision, result as DataReadResult<unknown>);
      return { value: result, hit: false, reason: cached.reason };
    } catch (error) {
      if (error instanceof DataRuntimeError) throw error;
      throw new DataRuntimeError("read_failed", "Data Runtime 读取失败", { cause: error });
    }
  }

  async loadRagSourcesCached(
    context: DataAccessContext,
    source: "project" | "file" | "conversation" | "knowledge" | "memory" | "canvas",
    revision: string,
    options: ReadOptions = {},
  ): Promise<CachedReadResult<RagSourceRecord>> {
    const ownerId = assertOwnerScope(context);
    const scopeType = context.scope?.type ?? "owner";
    const scopeId = context.scope?.id ?? ownerId;
    const key = `owner:${ownerId}|scope:${scopeType}:${scopeId}|source:${source}|after:${options.afterId ?? 0}|limit:${limitOf(options.limit)}`;
    const lookup = this.cache.get(key, revision);
    if (lookup.hit) {
      return {
        ...(lookup.value as DataReadResult<RagSourceRecord>),
        cache: { hit: true, reason: "hit", key, revision },
      };
    }
    const result = await this.loadRagSources(context, source, options);
    this.cache.set(key, revision, result);
    return { ...result, cache: { hit: false, reason: lookup.reason, key, revision } };
  }

  invalidateCache(key?: string): void {
    this.cache.invalidate(key);
  }

  invalidateForEvent(event: DataRuntimeInvalidationEvent): number {
    const ownerId = event.ownerId.trim();
    if (!ownerId) return 0;
    const scopeId = event.scopeId?.trim();
    return this.cache.invalidateWhere((key) => {
      if (!key.includes(`owner:${ownerId}|`)) return false;
      if (event.resource !== "all" && !key.includes(`|source:${event.resource}|`)) return false;
      if (event.scopeType === "owner" && scopeId && !key.includes(`|scope:owner:${scopeId}|`)) return false;
      return true;
    });
  }

  cacheSize(): number {
    return this.cache.size();
  }

  async loadProjects(
    context: DataAccessContext,
    options: ReadOptions = {},
  ): Promise<DataReadResult<ProjectRecord>> {
    const ownerId = assertOwnerScope(context);
    const limit = limitOf(options.limit);
    const afterId = afterIdOf(options.afterId);
    const rows = await this.query(() => this.sql`
      SELECT id, name, client, status, start_date, deadline, progress,
             current_stage, priority, version, updated_at
      FROM projects
      WHERE user_id = ${ownerId} AND archived = FALSE AND id > ${afterId}
      ORDER BY id ASC
      LIMIT ${limit}
    `);
    const records = rows.map((row) => ({
      id: Number(row.id),
      source_type: "project" as const,
      scope: ownerScope(ownerId),
      title: String(row.name || "未命名项目"),
      content: [
        `项目：${row.name || "未命名项目"}`,
        row.client ? `客户：${row.client}` : "",
        row.status ? `状态：${row.status}` : "",
        row.progress != null ? `进度：${row.progress}%` : "",
        row.current_stage ? `当前阶段：${row.current_stage}` : "",
        row.start_date ? `开始日期：${row.start_date}` : "",
        row.deadline ? `截止日期：${row.deadline}` : "",
      ].filter(Boolean).join("\n"),
      document_version: String(row.version || 1),
      updated_at: row.updated_at?.toISOString?.() ?? String(row.updated_at || ""),
      metadata: { status: String(row.status || "pending") },
    }));
    return { records, nextAfterId: records.length === limit ? Number(records.at(-1)?.id) : undefined };
  }

  async loadFileMetadata(
    context: DataAccessContext,
    options: ReadOptions = {},
  ): Promise<DataReadResult<FileMetadataRecord>> {
    const ownerId = assertOwnerScope(context);
    const limit = limitOf(options.limit);
    const afterId = afterIdOf(options.afterId);
    const rows = await this.query(() => this.sql`
      SELECT id, display_name, ext, space, project_id, folder_id,
             mime_type, size_bytes, version, updated_at
      FROM files
      WHERE user_id = ${ownerId} AND deleted_at IS NULL AND id > ${afterId}
      ORDER BY id ASC
      LIMIT ${limit}
    `);
    const records = rows.map((row) => ({
      id: Number(row.id),
      source_type: "file" as const,
      scope: ownerScope(ownerId),
      title: String(row.display_name || "未命名文件"),
      content: [
        `文件：${row.display_name || "未命名文件"}`,
        row.ext ? `类型：${row.ext}` : "",
        row.space ? `空间：${row.space}` : "",
      ].filter(Boolean).join("\n"),
      document_version: String(row.version || 1),
      updated_at: row.updated_at?.toISOString?.() ?? String(row.updated_at || ""),
      display_name: String(row.display_name || "未命名文件"),
      ext: row.ext ? String(row.ext) : undefined,
      mime_type: row.mime_type ? String(row.mime_type) : undefined,
      project_id: row.project_id == null ? null : Number(row.project_id),
      folder_id: row.folder_id == null ? null : Number(row.folder_id),
      size_bytes: Number(row.size_bytes || 0),
      metadata: {
        space: String(row.space || ""),
        project_id: row.project_id == null ? "" : String(row.project_id),
        folder_id: row.folder_id == null ? "" : String(row.folder_id),
      },
    }));
    return { records, nextAfterId: records.length === limit ? Number(records.at(-1)?.id) : undefined };
  }

  async loadConversationMessages(
    context: DataAccessContext,
    options: ReadOptions = {},
  ): Promise<DataReadResult<ConversationRecord>> {
    const ownerId = assertOwnerScope(context);
    const limit = limitOf(options.limit);
    const afterId = afterIdOf(options.afterId);
    const rows = await this.query(() => this.sql`
      SELECT m.id AS message_id, m.session_id, m.role, m.content,
             m.created_at, s.title, s.summary
      FROM conversation_messages AS m
      JOIN conversation_sessions AS s ON s.id = m.session_id
      WHERE s.user_id = ${ownerId}
        AND m.id > ${afterId}
        AND m.role IN ('user', 'assistant')
        AND m.content_json IS NULL
      ORDER BY m.id ASC
      LIMIT ${limit}
    `);
    const records = rows.flatMap((row) => {
      if (row.content == null || !String(row.content).trim()) return [];
      return [{
        id: Number(row.message_id),
        session_id: Number(row.session_id),
        message_id: Number(row.message_id),
        role: row.role as "user" | "assistant",
        source_type: "conversation" as const,
        scope: ownerScope(ownerId),
        title: String(row.title || "未命名对话"),
        summary: String(row.summary || ""),
        content: String(row.content),
        document_version: String(row.message_id),
        updated_at: row.created_at?.toISOString?.() ?? String(row.created_at || ""),
        metadata: { session_id: String(row.session_id), message_id: String(row.message_id), role: String(row.role) },
      }];
    });
    return { records, nextAfterId: records.length === limit ? Number(records.at(-1)?.id) : undefined };
  }

  async loadKnowledge(
    context: DataAccessContext,
    options: ReadOptions = {},
  ): Promise<DataReadResult<KnowledgeRecord>> {
    const ownerId = assertOwnerScope(context);
    const limit = limitOf(options.limit);
    const afterId = afterIdOf(options.afterId);
    const rows = await this.query(() => this.sql`
      SELECT id, source_type, source_id, scope_type, scope_id, platform, bot_id,
             group_id, document_id, parent_document_id, document_version, chunk_index,
             chunk_count, title, summary, content, metadata_json, source_updated_at
      FROM knowledge_index_entries
      WHERE owner_user_id = ${ownerId} AND deleted_at IS NULL AND id > ${afterId}
      ORDER BY id ASC
      LIMIT ${limit}
    `);
    const records = rows.map((row) => ({
      id: String(row.id), source_type: "knowledge" as const,
      scope: {
        scope_type: String(row.scope_type || "owner"), scope_id: String(row.scope_id || ""),
        platform: String(row.platform || ""), bot_id: String(row.bot_id || ""),
        group_id: String(row.group_id || ""),
      },
      title: String(row.title || "未命名知识"), summary: String(row.summary || ""),
      content: String(row.content || ""), document_version: String(row.document_version || "1"),
      updated_at: row.source_updated_at?.toISOString?.() ?? String(row.source_updated_at || ""),
      metadata: {
        source_id: String(row.source_id || ""), document_id: String(row.document_id || ""),
        parent_id: String(row.parent_document_id || ""), chunk_index: Number(row.chunk_index || 0),
        chunk_count: Number(row.chunk_count || 1), ...(row.metadata_json || {}),
      },
    } satisfies KnowledgeRecord));
    return { records, nextAfterId: records.length === limit ? Number(rows.at(-1)?.id) : undefined };
  }

  async loadMemory(
    context: DataAccessContext,
    storage: StorageReader,
  ): Promise<DataReadResult<MemoryRecord>> {
    const ownerId = assertOwnerScope(context);
    const keys = ["profile.json", "pattern.json", "summary.json", "daily.md", "memory.md"];
    const records: MemoryRecord[] = [];
    for (const key of keys) {
      const content = await storage.readText({ ownerId, key: `${ownerId}/.agent/${key}`, maxChars: 200_000 });
      if (!content?.trim()) continue;
      records.push({
        id: key, source_type: "memory", storage_key: key, scope: ownerScope(ownerId),
        title: key, content: content.trim(), document_version: `${key}:${content.length}`,
        metadata: { storage_key: key },
      });
    }
    return { records };
  }

  async loadCanvas(
    context: DataAccessContext,
    options: ReadOptions = {},
  ): Promise<DataReadResult<CanvasRecord>> {
    const ownerId = assertOwnerScope(context);
    const limit = limitOf(options.limit);
    const afterId = afterIdOf(options.afterId);
    const rows = await this.query(() => this.sql`
      SELECT i.id, i.canvas_id, i.node_id, i.data_json, i.updated_at,
             m.title AS canvas_title, m.project_id,
             n.title AS node_title, n.kind AS node_type,
             n.content_plain, n.content_md, n.version AS node_version
      FROM mind_canvas_items AS i
      JOIN mind_maps AS m ON m.id = i.canvas_id AND m.user_id = ${ownerId}
      JOIN mind_nodes AS n ON n.id = i.node_id AND n.user_id = ${ownerId}
      WHERE i.user_id = ${ownerId} AND n.deleted_at IS NULL AND i.id > ${afterId}
      ORDER BY i.id ASC
      LIMIT ${limit}
    `);
    const records = rows.map((row) => {
      let groupPath = "";
      try {
        const view = JSON.parse(String(row.data_json || "{}"));
        groupPath = String(view.group_path || view.groupPath || "");
      } catch { /* 损坏的视图状态不应阻断正文读取。 */ }
      const content = [
        `画布：${row.canvas_title || "未命名画布"}`,
        `节点：${row.node_title || "未命名节点"}`,
        `类型：${row.node_type || ""}`, groupPath ? `分组：${groupPath}` : "",
        String(row.content_plain || row.content_md || ""),
      ].filter(Boolean).join("\n");
      return {
        id: String(row.id), source_type: "canvas" as const, canvas_id: Number(row.canvas_id), node_id: Number(row.node_id),
        scope: ownerScope(ownerId), title: `${row.canvas_title || "未命名画布"} · ${row.node_title || "未命名节点"}`,
        content, document_version: `${row.updated_at || ""}:${row.node_version || 1}`,
        updated_at: row.updated_at?.toISOString?.() ?? String(row.updated_at || ""),
        metadata: { canvas_id: Number(row.canvas_id), node_id: Number(row.node_id), node_type: String(row.node_type || ""), project_id: row.project_id == null ? null : Number(row.project_id) },
      } satisfies CanvasRecord;
    });
    return { records, nextAfterId: records.length === limit ? Number(rows.at(-1)?.id) : undefined };
  }

  async loadRagSources(
    context: DataAccessContext,
    source: "project" | "file" | "conversation" | "knowledge" | "memory" | "canvas",
    options: ReadOptions = {},
  ): Promise<DataReadResult<RagSourceRecord>> {
    if (source === "project") return this.loadProjects(context, options);
    if (source === "file") return this.loadFileMetadata(context, options);
    if (source === "conversation") return this.loadConversationMessages(context, options);
    if (source === "knowledge") return this.loadKnowledge(context, options);
    if (source === "canvas") return this.loadCanvas(context, options);
    throw new DataRuntimeError("read_failed", "Memory 来源需要显式 StorageReader");
  }

  private async query<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new DataRuntimeError("database_unavailable", "Data Runtime 已关闭");
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DataRuntimeError) throw error;
      throw new DataRuntimeError("database_unavailable", "Data Runtime 数据库读取失败", { cause: error });
    }
  }
}
