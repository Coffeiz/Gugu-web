import { createHash } from "node:crypto";
import type { RagCitation, RagDocument } from "../../../../packages/contracts/src/rag.ts";
import { tokenize } from "../scorer/bm25.ts";

export function compact(value: string): string {
  return String(value || "").replace(/\s+/gu, "").trim().toLocaleLowerCase();
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function contentHashes(value: string): string[] {
  const text = String(value || "").trim();
  return [digest(text), digest(text.replace(/\s+/gu, ""))];
}

export function contentKey(value: string): string {
  return digest(compact(value));
}

export function citation(document: RagDocument): RagCitation {
  const metadata = document.metadata ?? {};
  const sourceId = String(metadata.source_id ?? document.parent_id ?? document.id);
  const chunkId = `${document.parent_id ?? document.id}:${document.document_version}:${document.chunk_index ?? 0}`;
  return {
    source_type: document.source_type,
    source_id: sourceId,
    title: String(document.title ?? "未命名来源"),
    chunk_id: chunkId,
    version: document.document_version,
    ...(document.updated_at ? { updated_at: document.updated_at } : {}),
  };
}

export function tokenSet(document: RagDocument): Set<string> {
  return new Set(tokenize(document.text));
}

export function similarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}
