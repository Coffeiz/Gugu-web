import { createHash } from "node:crypto";
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

/** 与 Python text_version 逐位一致：sha256("\x1f".join([*parts, text]))[:16]。 */
export function textVersion(text: string, ...parts: (string | number)[]): string {
  const payload = [...parts.map((part) => String(part ?? "")), text].join("\x1f");
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

export function buildDocuments(
  record: RagSourceRecord,
  maxChars = 1400,
): RagDocument[] {
  // Python _documents 先 strip 再分块、取摘要，这里保持同一口径。
  const normalized = String(record.content || "").trim();
  const chunks = chunkText(normalized, maxChars);
  if (!chunks.length) return [];
  // parent_id = document_id = "{source_type}:{source_id}"；
  // wire id = _worker_document_key = "{source_type}:{document_id}:{chunkIndex}"（id 双重前缀是现网口径）。
  const parentId = `${record.source_type}:${record.id}`;
  const summary = record.summary || normalized.slice(0, 240);
  const parts = record.version_parts;
  const documentVersion = parts
    ? textVersion(normalized, ...parts)
    : record.document_version;
  // Python _wire_document 口径：text = title\nsummary\ncontent（检索索引正文），
  // content 只保留 chunk 正文；两侧 BM25 必须索引同一份文本。
  const title = record.title || "未命名";
  return chunks.map((text, chunkIndex) => ({
    id: `${record.source_type}:${parentId}:${chunkIndex}`,
    text: [title, summary, text].join("\n"),
    content: text,
    source_type: record.source_type,
    source_id: String(record.id),
    title,
    summary,
    ...record.scope,
    scope_type: record.scope.scope_type || "owner",
    scope_id: record.scope.scope_id || "",
    document_version: documentVersion,
    parent_id: parentId,
    chunk_index: chunkIndex,
    chunk_count: chunks.length,
    updated_at: record.updated_at,
    metadata: record.metadata,
  }));
}

export function validScope(scope: RagSearchScope): boolean {
  // Python 生产 owner scope 即 scope_type="owner"、scope_id=""，不得比现网更严；
  // group scope 必须携带群 id 才构成有效检索边界。
  if (!scope.scope_type) return false;
  if (scope.scope_type === "group" && !scope.scope_id) return false;
  return true;
}
