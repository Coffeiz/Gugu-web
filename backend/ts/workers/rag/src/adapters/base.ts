import type { RagDocument, RagSearchScope, RagSourceRecord } from "../../../../packages/contracts/src/rag.ts";

export type SourceAdapter<T> = {
  sourceType: string;
  toDocuments(records: readonly T[]): RagDocument[];
};

export function chunkText(text: string, maxChars = 1400, overlap = 120): string[] {
  const normalized = String(text || "").trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n\s*\n/gu).map((part) => part.trim()).filter(Boolean);
  const output: string[] = [];
  let buffer = "";
  for (const paragraph of paragraphs) {
    const pieces = paragraph.split(/(?<=[。！？!?；;\n])/u).map((part) => part.trim()).filter(Boolean);
    for (const piece of pieces) {
      if (piece.length > maxChars) {
        if (buffer) { output.push(buffer.trim()); buffer = ""; }
        const step = Math.max(1, maxChars - overlap);
        for (let start = 0; start < piece.length; start += step) {
          const chunk = piece.slice(start, start + maxChars).trim();
          if (chunk) output.push(chunk);
        }
        continue;
      }
      const candidate = buffer ? `${buffer}\n${piece}`.trim() : piece;
      if (buffer && candidate.length > maxChars) {
        output.push(buffer.trim());
        const tail = buffer.slice(-overlap).trim();
        buffer = tail ? `${tail}\n${piece}`.trim() : piece;
      } else {
        buffer = candidate;
      }
    }
  }
  if (buffer) output.push(buffer.trim());
  return output;
}

export function buildDocuments(
  record: RagSourceRecord,
  maxChars = 1400,
): RagDocument[] {
  const chunks = chunkText(record.content, maxChars);
  const parentId = `${record.source_type}:${record.id}`;
  const summary = record.summary || String(record.content || "").trim().slice(0, 240);
  return chunks.map((text, chunkIndex) => ({
    id: `${parentId}:${chunkIndex}`,
    text,
    source_type: record.source_type,
    title: record.title,
    summary,
    ...record.scope,
    scope_type: record.scope.scope_type || "owner",
    scope_id: record.scope.scope_id || "",
    document_version: record.document_version,
    parent_id: parentId,
    chunk_index: chunkIndex,
    chunk_count: chunks.length,
    updated_at: record.updated_at,
    metadata: record.metadata,
  }));
}

export function validScope(scope: RagSearchScope): boolean {
  return Boolean(scope.scope_type && scope.scope_id);
}
