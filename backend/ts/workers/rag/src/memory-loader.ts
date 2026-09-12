import { createHash } from "node:crypto";
import type { RagDocument, RagSourceRecord } from "../../../packages/contracts/src/rag.ts";
import { assertOwnerScope, type DataAccessContext, type DataScope, type StorageReader } from "../../../packages/data-runtime/src/contracts.ts";
import { DataRuntime } from "../../../packages/data-runtime/src/runtime.ts";
import { buildDocuments } from "./adapters/base.ts";

const MEMORY_INDEX_KEY = ".agent/rag/memory-index-v1.json";
const MEMORY_CACHE_TTL_MS = 30 * 60 * 1000;
const MEMORY_SOURCES = new Set(["profile", "pattern", "daily", "memory"]);
const memoryCache = new Map<string, { revision: string; documents: RagDocument[]; lastAccess: number }>();

export type AuthorizedMemoryScope = DataScope & {
  ownerId: string;
  type: "owner" | "group" | "member";
};

export type PreparedMemory = {
  documents: RagDocument[];
  vectors: Record<string, number[]>;
  indexSource: string;
  probe: {
    stage_ms: Record<string, number>;
    counts: Record<string, number>;
    cache: Record<string, boolean>;
  };
};

type MemoryProbe = PreparedMemory["probe"];

function recordElapsed(probe: MemoryProbe, stage: string, started: number): void {
  probe.stage_ms[stage] = Math.max(0, Math.round(performance.now() - started));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function safeComponent(value: string, label: string): string {
  const text = String(value || "").trim();
  if (!text || text === "." || text === ".." || /[/\\\0]/u.test(text)) {
    throw new Error(`RAG Worker 拒绝非法 Memory ${label}`);
  }
  return encodeURIComponent(text).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function assertScopes(ownerId: string, scopes: AuthorizedMemoryScope[]): AuthorizedMemoryScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return [{ type: "owner", id: ownerId, ownerId }];
  }
  const seen = new Set<string>();
  return scopes.map((scope) => {
    const scopeOwner = String(scope?.ownerId || "").trim();
    if (!scope || scopeOwner.toLowerCase() !== ownerId.toLowerCase()) {
      throw new Error("RAG Worker 拒绝不匹配的 Memory owner scope");
    }
    if (!["owner", "group", "member"].includes(scope.type)) {
      throw new Error("RAG Worker 拒绝不支持的 Memory scope");
    }
    if (scope.type === "owner") {
      if (scope.id !== ownerId) throw new Error("RAG Worker 拒绝不匹配的 owner scope");
    } else {
      const scopeId = String(scope.id || "");
      if (!scopeId || !scope.platform || !scope.botId || (scope.type === "member" && !scope.groupId)) {
        throw new Error("RAG Worker 拒绝不完整的 Memory scope");
      }
      if (scope.type === "group" && scope.groupId && scope.groupId !== scopeId) {
        throw new Error("RAG Worker 拒绝不匹配的群组 scope");
      }
      if (scope.type === "member" && !scopeId.startsWith(`${scope.groupId}:`)) {
        throw new Error("RAG Worker 拒绝不匹配的成员 scope");
      }
      safeComponent(scope.platform, "platform");
      safeComponent(scope.botId, "botId");
      safeComponent(scopeId, "scopeId");
    }
    const key = [scope.type, scope.id, scope.platform || "", scope.botId || "", scope.groupId || ""].join("\x1f");
    if (seen.has(key)) throw new Error("RAG Worker 拒绝重复的 Memory scope");
    seen.add(key);
    return scope;
  });
}

function cacheKey(ownerId: string, scopes: AuthorizedMemoryScope[], sourceFilter: string): string {
  return createHash("sha256").update(JSON.stringify({
    ownerId, sourceFilter,
    scopes: scopes.map(({ type, id, platform, botId, groupId }) => ({ type, id, platform, botId, groupId })),
  })).digest("hex");
}

function pruneMemoryCache(now: number): void {
  for (const [key, entry] of memoryCache) {
    if (now - entry.lastAccess >= MEMORY_CACHE_TTL_MS) memoryCache.delete(key);
  }
  while (memoryCache.size > 256) {
    const oldest = memoryCache.keys().next().value as string | undefined;
    if (!oldest) break;
    memoryCache.delete(oldest);
  }
}

function memoryDocumentFromStored(ownerId: string, value: unknown): RagDocument | null {
  const row = objectValue(value);
  const scope = objectValue(row?.scope);
  const metadata = objectValue(row?.metadata);
  if (!row || !scope || String(scope.owner_user_id || "").toLowerCase() !== ownerId.toLowerCase()) return null;
  if (String(row.source_type || "") !== "memory" || !MEMORY_SOURCES.has(String(row.source_id || ""))) return null;
  const documentId = String(row.document_id || "");
  const parentId = String(row.parent_document_id || documentId);
  const chunkIndex = Math.max(0, Number(row.chunk_index) || 0);
  const sourceId = String(row.source_id || "");
  const title = String(row.title || "");
  const summary = String(row.summary || "");
  const content = String(row.content || "");
  if (!documentId || !parentId || !title || !content.trim()) return null;
  return {
    id: `memory:${parentId}:${chunkIndex}`,
    text: [title, ...(summary ? [summary] : []), content].join("\n"),
    content,
    source_type: "memory",
    source_id: sourceId,
    title,
    summary,
    platform: String(scope.platform || ""),
    bot_id: String(scope.bot_id || ""),
    group_id: String(scope.group_id || ""),
    scope_type: String(scope.scope_type || "owner"),
    scope_id: String(scope.scope_id || ""),
    document_version: String(row.version || ""),
    parent_id: parentId,
    chunk_index: chunkIndex,
    chunk_count: Math.max(1, Number(row.chunk_count) || 1),
    ...(row.updated_at ? { updated_at: String(row.updated_at) } : {}),
    metadata: (metadata || {}) as RagDocument["metadata"],
  };
}

function parseJson(value: string | null): unknown {
  if (!value?.trim()) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function scopeValueText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(scopeValueText).filter(Boolean).join("\n");
  const object = objectValue(value);
  if (object) {
    for (const key of ["text", "content", "summary", "value"]) {
      const candidate = object[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    return "";
  }
  return value == null || value === false || value === 0 ? "" : String(value).trim();
}

function memoryRecord(
  ownerId: string,
  scope: AuthorizedMemoryScope,
  sourceId: string,
  textValue: string,
  title: string,
  index: number,
  stableId?: string,
): RagSourceRecord | null {
  const content = textValue.trim();
  if (!content) return null;
  const sourceKey = stableId || `${sourceId}:${index}`;
  const recordScope = scope.type === "owner"
    ? { scope_type: "owner", scope_id: "", platform: "", bot_id: "", group_id: "" }
    : {
        scope_type: scope.type,
        scope_id: scope.id,
        platform: scope.platform || "",
        bot_id: scope.botId || "",
        group_id: scope.groupId || (scope.type === "group" ? scope.id : ""),
      };
  return {
    id: sourceKey,
    source_id: sourceId,
    parent_id: `memory:${sourceId}:${sourceKey}`,
    source_type: "memory",
    title,
    summary: Array.from(content).slice(0, 240).join(""),
    content,
    document_version: "",
    version_parts: [sourceId, sourceKey],
    scope: recordScope,
    metadata: { vector_key: sourceId === "pattern" ? sourceKey : "" },
  };
}

function buildMemoryDocuments(ownerId: string, scope: AuthorizedMemoryScope, records: RagSourceRecord[]): RagDocument[] {
  assertOwnerScope({ ownerId });
  return records.flatMap((record) => buildDocuments(record));
}

function profileItems(value: unknown): Array<{ text: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = typeof item === "string" ? item.trim() : String(objectValue(item)?.text || "").trim();
    return text ? [{ text }] : [];
  });
}

function patternItems(primary: unknown, legacyJson: unknown, legacyMarkdown: string | null): Array<{ id: string; text: string }> {
  const primaryList = Array.isArray(primary) ? primary : null;
  if (primaryList) {
    return primaryList.flatMap((item, index) => {
      const object = objectValue(item);
      const text = String(object?.text || "").trim();
      return text ? [{ id: String(object?.id || `pattern:${index}`), text }] : [];
    });
  }
  const legacyList = Array.isArray(legacyJson) ? legacyJson : null;
  if (legacyList) {
    const items = legacyList.flatMap((item, index) => {
      const object = objectValue(item);
      const text = String(object?.text || "").trim();
      return text ? [{ id: String(object?.id || `legacy-pattern:${index}`), text }] : [];
    });
    if (items.length) return items;
  }
  return String(legacyMarkdown || "").split(/\r?\n/u).flatMap((line, index) => {
    const text = line.trim().replace(/^-\s*/u, "").trim();
    if (!text) return [];
    const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
    return [{ id: `legacy-pattern:${digest}:${index}`, text }];
  });
}

function dailyLines(value: string | null): string[] {
  const output: string[] = [];
  let currentDate = "";
  for (const raw of String(value || "").split(/\r?\n/u)) {
    const line = raw.trim();
    const heading = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/u);
    if (heading) { currentDate = heading[1]; continue; }
    const bullet = line.match(/^-\s+(.+?)\s*$/u);
    if (currentDate && bullet?.[1]) output.push(`- ${currentDate} ${bullet[1].trim()}`);
  }
  return output;
}

function splitSections(text: string): Array<{ title: string; content: string }> {
  const normalized = String(text || "").trim();
  if (!normalized) return [];
  const heading = /^#{1,6}\s+(.+?)\s*$/gmu;
  const matches = [...normalized.matchAll(heading)];
  if (!matches.length) return [{ title: "", content: normalized }];
  const sections: Array<{ title: string; content: string }> = [];
  if ((matches[0].index || 0) > 0) {
    const content = normalized.slice(0, matches[0].index).trim();
    if (content) sections.push({ title: "", content });
  }
  matches.forEach((match, index) => {
    const start = (match.index || 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index || normalized.length) : normalized.length;
    const content = normalized.slice(start, end).trim();
    if (content) sections.push({ title: String(match[1] || "").trim(), content });
  });
  return sections;
}

async function readOwnerDocuments(ownerId: string, storage: StorageReader): Promise<{ documents: RagDocument[]; source: string }> {
  const base = `${ownerId}/.agent/`;
  const indexRaw = await storage.readText({ ownerId, key: `${ownerId}/${MEMORY_INDEX_KEY}`, maxChars: 50_000_000 });
  const dailyRaw = await storage.readText({ ownerId, key: `${base}daily.md`, maxChars: 500_000 });
  const indexValue = objectValue(parseJson(indexRaw));
  const storedRows = Array.isArray(indexValue?.documents) ? indexValue.documents : null;
  const hasValidIndex = indexValue?.schema_version === 1 && storedRows !== null;
  let documents: RagDocument[];
  if (hasValidIndex) {
    documents = storedRows!.map((row) => memoryDocumentFromStored(ownerId, row))
      .filter((document): document is RagDocument => document !== null && document.source_id !== "daily");
  } else {
    const [profileRaw, patternRaw, factsJsonRaw, factsMarkdown, memoryRaw] = await Promise.all([
      storage.readText({ ownerId, key: `${base}profile.json`, maxChars: 1_000_000 }),
      storage.readText({ ownerId, key: `${base}pattern.json`, maxChars: 2_000_000 }),
      storage.readText({ ownerId, key: `${base}facts.json`, maxChars: 2_000_000 }),
      storage.readText({ ownerId, key: `${base}facts.md`, maxChars: 2_000_000 }),
      storage.readText({ ownerId, key: `${base}memory.md`, maxChars: 20_000_000 }),
    ]);
    const records: RagSourceRecord[] = [];
    profileItems(parseJson(profileRaw)).forEach((item, index) => {
      const record = memoryRecord(ownerId, { type: "owner", id: ownerId, ownerId }, "profile", item.text, "用户画像", index);
      if (record) records.push(record);
    });
    const patterns = patternRaw !== null && !patternRaw.trim()
      ? []
      : patternItems(parseJson(patternRaw), parseJson(factsJsonRaw), factsMarkdown);
    patterns.forEach((item, index) => {
      const record = memoryRecord(ownerId, { type: "owner", id: ownerId, ownerId }, "pattern", item.text, "行为模式", index, item.id);
      if (record) records.push(record);
    });
    splitSections(memoryRaw || "").forEach((section, index) => {
      const text = `${section.title ? `${section.title}\n` : ""}${section.content}`.trim();
      const record = memoryRecord(ownerId, { type: "owner", id: ownerId, ownerId }, "memory", text, section.title || "长期记忆", index);
      if (record) records.push(record);
    });
    documents = buildMemoryDocuments(ownerId, { type: "owner", id: ownerId, ownerId }, records);
  }
  const dailyScope: AuthorizedMemoryScope = { type: "owner", id: ownerId, ownerId };
  const dailyRecords = dailyLines(dailyRaw).flatMap((line, index) => {
    const record = memoryRecord(ownerId, dailyScope, "daily", line, "近期记忆", index);
    return record ? [record] : [];
  });
  documents.push(...buildMemoryDocuments(ownerId, dailyScope, dailyRecords));
  return { documents, source: hasValidIndex ? "owner-index+daily" : "owner-files+daily" };
}

function groupScopePrefix(ownerId: string, scope: AuthorizedMemoryScope): string {
  const owner = safeComponent(ownerId, "owner");
  const platform = safeComponent(String(scope.platform || ""), "platform");
  const bot = safeComponent(String(scope.botId || ""), "botId");
  const id = safeComponent(String(scope.id || ""), "scopeId");
  const branch = scope.type === "group" ? "groups" : "platform-users";
  return `${owner}/.agent/im/${platform}/${bot}/${branch}/${id}/`;
}

function parseScopeFile(filename: string, raw: string | null): unknown {
  if (!raw?.trim()) return filename.endsWith(".json") ? {} : "";
  if (!filename.endsWith(".json")) return raw.trim();
  const value = parseJson(raw);
  return value && (Array.isArray(value) || objectValue(value)) ? value : {};
}

async function readScopedDocuments(
  ownerId: string,
  scope: AuthorizedMemoryScope,
  storage: StorageReader,
  revision: string,
): Promise<{ documents: RagDocument[]; revision: string; source: string }> {
  const filenames = scope.type === "group"
    ? ["profile.json", "summary.json", "daily.md", "memory.md"]
    : ["profile.json", "pattern.json", "summary.json", "daily.md", "memory.md"];
  const prefix = groupScopePrefix(ownerId, scope);
  const values = await Promise.all(filenames.map((filename) => storage.readText({
    ownerId, key: `${prefix}${filename}`, maxChars: 2_000_000,
  })));
  const data = Object.fromEntries(filenames.map((filename, index) => [
    filename.replace(/\.(json|md)$/u, ""), parseScopeFile(filename, values[index]),
  ]));
  const pairs: Array<[string, string]> = scope.type === "group"
    ? [["summary", "群组摘要"], ["profile", "群组资料"], ["daily", "群组近期记忆"], ["memory", "群组长期记忆"]]
    : [["summary", "群友摘要"], ["profile", "群友资料"], ["pattern", "群友行为模式"], ["memory", "群友事件记忆"]];
  const records = pairs.flatMap(([sourceId, title], index) => {
    const record = memoryRecord(ownerId, scope, sourceId, scopeValueText(data[sourceId]), title, index);
    return record ? [record] : [];
  });
  return { documents: buildMemoryDocuments(ownerId, scope, records), revision, source: `scope:${revision}` };
}

function snapshotCovers(text: string, snapshot: string): boolean {
  const normalized = Array.from(String(text || "").trim().replace(/\s+/gu, ""));
  const context = String(snapshot || "").replace(/\s+/gu, "");
  if (!normalized.length || !context) return false;
  const joined = normalized.join("");
  if (context.includes(joined)) return true;
  const minimum = Math.max(80, Math.floor(normalized.length * 0.7));
  for (let size = normalized.length; size >= minimum; size -= 1) {
    if (context.includes(normalized.slice(0, size).join(""))) return true;
  }
  return false;
}

function parseVectorMap(value: unknown, vectorVersion: string): Record<string, { v?: unknown; t?: unknown }> {
  const object = objectValue(value);
  if (!object) return {};
  return Object.fromEntries(Object.entries(object).flatMap(([key, raw]) => {
    const item = objectValue(raw);
    return item && item.t === vectorVersion && Array.isArray(item.v)
      && item.v.every((part) => typeof part === "number" && Number.isFinite(part))
      ? [[key, item as { v?: unknown; t?: unknown }]] : [];
  }));
}

export async function loadDocumentVectors(
  ownerId: string,
  documents: RagDocument[],
  vectorVersion: string,
  storage: StorageReader,
  probe?: MemoryProbe,
): Promise<Record<string, number[]>> {
  if (!vectorVersion || !documents.length) return {};
  const base = `${ownerId}/.agent/`;
  const storageStarted = performance.now();
  const [memoryRaw, knowledgeRaw, patternRaw] = await Promise.all([
    storage.readText({ ownerId, key: `${base}memory_vec.json`, maxChars: 50_000_000 }).catch(() => null),
    storage.readText({ ownerId, key: `${ownerId}/.agent/knowledge/vectors.json`, maxChars: 50_000_000 }).catch(() => null),
    storage.readText({ ownerId, key: `${base}pattern_vec.json`, maxChars: 50_000_000 }).catch(() => null),
  ]);
  if (probe) recordElapsed(probe, "vector_storage_read", storageStarted);
  const parseStarted = performance.now();
  const memory = parseVectorMap(parseJson(memoryRaw), vectorVersion);
  const knowledge = parseVectorMap(parseJson(knowledgeRaw), vectorVersion);
  const pattern = parseVectorMap(parseJson(patternRaw), vectorVersion);
  const vectors: Record<string, number[]> = {};
  for (const document of documents) {
    const parent = String(document.parent_id || document.id);
    const version = String(document.document_version || "");
    const chunkIndex = Number(document.chunk_index || 0);
    const chunkId = `${parent}:${version}:${chunkIndex}`;
    const documentKey = String(document.id || `memory:${parent}:${chunkIndex}`);
    const cacheKey = document.source_id === "pattern"
      ? String(document.metadata?.vector_key || "")
      : `rag:${chunkId}`;
    const cache = document.source_type === "knowledge" ? knowledge
      : document.source_id === "pattern" ? pattern : memory;
    const vector = cache[cacheKey]?.v;
    if (Array.isArray(vector) && vector.every((part) => typeof part === "number" && Number.isFinite(part))) {
      vectors[documentKey] = vector as number[];
    }
  }
  if (probe) {
    recordElapsed(probe, "vector_parse_and_match", parseStarted);
    probe.counts.vector_files_present = [memoryRaw, knowledgeRaw, patternRaw].filter((value) => value !== null).length;
    probe.counts.vector_entries_loaded = Object.keys(vectors).length;
  }
  return vectors;
}

export async function prepareMemory(
  input: {
    ownerId: string;
    scopes: AuthorizedMemoryScope[];
    sourceFilter: string;
    snapshotRevision: string;
    snapshotText: string;
    vectorVersion: string;
  },
  runtime: DataRuntime,
  storage: StorageReader,
): Promise<PreparedMemory> {
  const prepareStarted = performance.now();
  const probe: MemoryProbe = { stage_ms: {}, counts: {}, cache: { owner_cache_hit: false, scoped_cache_hit: false } };
  const ownerId = assertOwnerScope({ ownerId: input.ownerId });
  const scopes = assertScopes(ownerId, input.scopes);
  const sourceFilter = String(input.sourceFilter || "all");
  const key = cacheKey(ownerId, scopes, sourceFilter);
  const now = Date.now();
  let stageStarted = performance.now();
  pruneMemoryCache(now);
  recordElapsed(probe, "cache_prune", stageStarted);

  let baseDocuments: RagDocument[] = [];
  let sourceNames: string[] = [];
  let cacheRevision = "";
  if (scopes.some((scope) => scope.type === "owner")) {
    const snapshotRevision = String(input.snapshotRevision || "");
    stageStarted = performance.now();
    const cached = snapshotRevision ? memoryCache.get(key) : undefined;
    probe.cache.owner_cache_hit = Boolean(
      cached && cached.revision === `owner:${snapshotRevision}`
      && now - cached.lastAccess < MEMORY_CACHE_TTL_MS,
    );
    if (cached && cached.revision === `owner:${snapshotRevision}` && now - cached.lastAccess < MEMORY_CACHE_TTL_MS) {
      baseDocuments.push(...cached.documents);
      cached.lastAccess = now;
      sourceNames.push("owner-cache");
    } else {
      const readStarted = performance.now();
      const loaded = await readOwnerDocuments(ownerId, storage);
      recordElapsed(probe, "owner_document_read_and_adapt", readStarted);
      baseDocuments.push(...loaded.documents);
      sourceNames.push(loaded.source);
      if (snapshotRevision) {
        memoryCache.set(key, { revision: `owner:${snapshotRevision}`, documents: loaded.documents, lastAccess: now });
      }
    }
    recordElapsed(probe, "owner_cache_lookup", stageStarted);
    cacheRevision = snapshotRevision ? `owner:${snapshotRevision}` : "owner:unbound";
  }

  const scoped = scopes.filter((scope) => scope.type !== "owner");
  probe.counts.scope_count = scopes.length;
  probe.counts.scoped_scope_count = scoped.length;
  if (scoped.length) {
    stageStarted = performance.now();
    const states = await Promise.all(scoped.map(async (scope) => ({
      scope,
      state: await runtime.getMemoryScopeState({ ownerId }, {
        type: scope.type as "group" | "member", id: scope.id,
        platform: String(scope.platform || ""), botId: String(scope.botId || ""),
      }),
    })));
    recordElapsed(probe, "scope_state_read", stageStarted);
    const revisions = states.map(({ scope, state }) => `${scope.type}:${scope.id}:${state.revision}:${state.tombstoned ? 1 : 0}`);
    const revision = revisions.join("|");
    const scopedCacheKey = `${key}:${createHash("sha256").update(revision).digest("hex")}`;
    stageStarted = performance.now();
    const cached = memoryCache.get(scopedCacheKey);
    probe.cache.scoped_cache_hit = Boolean(
      cached && cached.revision === revision && now - cached.lastAccess < MEMORY_CACHE_TTL_MS,
    );
    if (cached && cached.revision === revision && now - cached.lastAccess < MEMORY_CACHE_TTL_MS) {
      baseDocuments.push(...cached.documents);
      cached.lastAccess = now;
      sourceNames.push("scope-cache");
    } else {
      const readStarted = performance.now();
      const loaded = await Promise.all(states.map(({ scope, state }) => state.tombstoned
        ? Promise.resolve({ documents: [], revision: `tombstoned:${state.revision}`, source: "scope-tombstone" })
        : readScopedDocuments(ownerId, scope, storage, state.revision)));
      recordElapsed(probe, "scoped_document_read_and_adapt", readStarted);
      const documents = loaded.flatMap((entry) => entry.documents);
      baseDocuments.push(...documents);
      sourceNames.push(...loaded.map((entry) => entry.source));
      memoryCache.set(scopedCacheKey, { revision, documents, lastAccess: now });
    }
    recordElapsed(probe, "scoped_cache_lookup", stageStarted);
    cacheRevision = [cacheRevision, revision].filter(Boolean).join("|");
  }

  probe.counts.base_documents = baseDocuments.length;
  const allowedSources = sourceFilter === "all" ? MEMORY_SOURCES : new Set([sourceFilter]);
  stageStarted = performance.now();
  const sourceAllowed = baseDocuments.filter((document) =>
    allowedSources.has(String(document.source_id || "")),
  );
  recordElapsed(probe, "source_filter", stageStarted);
  probe.counts.source_allowed_documents = sourceAllowed.length;
  stageStarted = performance.now();
  const scopeAuthorized = sourceAllowed.filter((document) => scopes.some((scope) => {
      if (scope.type === "owner") return document.scope_type === "owner";
      return document.scope_type === scope.type
        && document.scope_id === scope.id
        && document.platform === scope.platform
        && document.bot_id === scope.botId
        && document.group_id === (scope.groupId || (scope.type === "group" ? scope.id : ""));
    }));
  recordElapsed(probe, "scope_filter", stageStarted);
  probe.counts.scope_authorized_documents = scopeAuthorized.length;
  stageStarted = performance.now();
  const selected = scopeAuthorized.filter((document) =>
    !snapshotCovers(String(document.content || ""), input.snapshotText));
  recordElapsed(probe, "snapshot_dedup_filter", stageStarted);
  probe.counts.snapshot_excluded_documents = scopeAuthorized.length - selected.length;
  probe.counts.selected_documents = selected.length;

  stageStarted = performance.now();
  const vectors = await loadDocumentVectors(ownerId, selected, input.vectorVersion, storage, probe);
  recordElapsed(probe, "vector_load", stageStarted);
  stageStarted = performance.now();
  pruneMemoryCache(Date.now());
  recordElapsed(probe, "cache_prune_final", stageStarted);
  probe.counts.vector_count = Object.keys(vectors).length;
  recordElapsed(probe, "prepare_memory_total", prepareStarted);
  return {
    documents: selected, vectors,
    indexSource: sourceNames.join(",") || cacheRevision || "empty",
    probe,
  };
}
