import { createHash } from "node:crypto";
import type { RagSourceRecord } from "../../contracts/src/rag.ts";
import type { ChunkPatch, DataChunk, DataDocument } from "./contracts.ts";

const DEFAULT_CHUNK_CHARS = 1400;
const DEFAULT_OVERLAP_CHARS = 120;

export function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function chunkText(
  text: string,
  maxChars = DEFAULT_CHUNK_CHARS,
  overlap = DEFAULT_OVERLAP_CHARS,
): string[] {
  const normalized = String(text || "").trim();
  if (!normalized) return [];
  const output: string[] = [];
  const step = Math.max(1, maxChars - overlap);
  for (let start = 0; start < normalized.length; start += step) {
    const chunk = normalized.slice(start, start + maxChars).trim();
    if (chunk) output.push(chunk);
    if (start + maxChars >= normalized.length) break;
  }
  return output;
}

export function buildChunks(
  record: RagSourceRecord,
  maxChars = DEFAULT_CHUNK_CHARS,
  overlap = DEFAULT_OVERLAP_CHARS,
): DataChunk[] {
  const parentId = `${record.source_type}:${record.id}`;
  const pieces = chunkText(record.content, maxChars, overlap);
  const base: DataDocument = {
    id: parentId,
    source_type: record.source_type,
    scope_type: record.scope.scope_type || "owner",
    scope_id: record.scope.scope_id || "",
    parent_id: parentId,
    title: record.title,
    summary: record.summary,
    document_version: record.document_version,
    updated_at: record.updated_at,
    metadata: record.metadata,
  };
  return pieces.map((text, chunkIndex) => ({
    ...base,
    chunk_id: `${record.source_type}:${record.id}:${chunkIndex}`,
    chunk_index: chunkIndex,
    chunk_count: pieces.length,
    text,
    digest: digestText(text),
  }));
}

export function diffChunks(previous: readonly DataChunk[], next: readonly DataChunk[]): ChunkPatch {
  const oldById = new Map(previous.map((chunk) => [chunk.chunk_id, chunk]));
  const nextIds = new Set(next.map((chunk) => chunk.chunk_id));
  const upserts = next.filter((chunk) => oldById.get(chunk.chunk_id)?.digest !== chunk.digest);
  const deletes = previous.filter((chunk) => !nextIds.has(chunk.chunk_id)).map((chunk) => chunk.chunk_id);
  return { upserts, deletes };
}
