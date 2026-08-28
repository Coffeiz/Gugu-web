import type { RagSourceBatch } from "../../contracts/src/rag.ts";
import { assertOwnerScope, type DataAccessContext, type DataReadResult, type MemoryRecord, type StorageReader } from "./contracts.ts";
import { DataRuntime } from "./runtime.ts";

export type DataRuntimeRagSources = "project" | "file" | "conversation" | "knowledge" | "canvas";

/** 将 Data Runtime 的 canonical 读取结果转换为 TS RAG 的 batch。 */
export async function loadRagBatch(
  runtime: DataRuntime,
  context: DataAccessContext,
  sources: readonly DataRuntimeRagSources[] = ["project", "file", "conversation", "knowledge", "canvas"],
): Promise<RagSourceBatch> {
  const batch: RagSourceBatch = {};
  for (const source of sources) {
    const result = await runtime.loadRagSources(context, source);
    const records = result.records as Record<string, unknown>[];
    if (source === "project") batch.project = records;
    if (source === "file") batch.files = records;
    if (source === "conversation") batch.conversations = records;
    if (source === "knowledge") batch.knowledge = records;
    if (source === "canvas") batch.canvas = records;
  }
  return batch;
}

/** 带统一 revision/TTL 的生产 batch 入口；Memory 需单独通过 StorageReader 读取。 */
export async function loadRagBatchCached(
  runtime: DataRuntime,
  context: DataAccessContext,
  revision: string,
  sources: readonly DataRuntimeRagSources[] = ["project", "file", "conversation", "knowledge", "canvas"],
): Promise<{ batch: RagSourceBatch; cache: Record<string, { hit: boolean; revision: string }> }> {
  const batch: RagSourceBatch = {};
  const cache: Record<string, { hit: boolean; revision: string }> = {};
  for (const source of sources) {
    const result = await runtime.loadRagSourcesCached(context, source, revision);
    const records = result.records as Record<string, unknown>[];
    if (source === "project") batch.project = records;
    if (source === "file") batch.files = records;
    if (source === "conversation") batch.conversations = records;
    if (source === "knowledge") batch.knowledge = records;
    if (source === "canvas") batch.canvas = records;
    cache[source] = { hit: result.cache.hit, revision: result.cache.revision };
  }
  return { batch, cache };
}

/** Memory 的对象存储读取保持显式，避免把私有文件误当成数据库来源。 */
export async function loadMemoryCached(
  runtime: DataRuntime,
  context: DataAccessContext,
  storage: StorageReader,
  revision: string,
): Promise<{ records: MemoryRecord[]; cache: { hit: boolean; revision: string } }> {
  const ownerId = assertOwnerScope(context);
  const key = `owner:${ownerId}|scope:owner:${ownerId}|source:memory|page:full`;
  const cached = await runtime.readCachedWithStatus(key, revision, () => runtime.loadMemory(context, storage));
  return { records: cached.value.records, cache: { hit: cached.hit, revision } };
}

export function emptyReadResult<T>(): DataReadResult<T> {
  return { records: [] };
}
