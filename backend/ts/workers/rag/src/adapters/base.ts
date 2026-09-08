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
  // Python len/slice 按 Unicode 码点计数，JS string 按 UTF-16 码元：含非 BMP 字符
  // （emoji、扩展汉字）时边界会漂移，因此 buffer 一律以码点数组持有与测量。
  let buffer: string[] = [];
  for (const paragraph of paragraphs) {
    const pieces = paragraph.split(/(?<=[。！？!?；;\n])/u).map((part) => part.trim()).filter(Boolean);
    for (const piece of pieces) {
      const chars = Array.from(piece);
      if (chars.length > maxChars) {
        if (buffer.length) { output.push(buffer.join("").trim()); buffer = []; }
        const step = Math.max(1, maxChars - overlap);
        for (let start = 0; start < chars.length; start += step) {
          const chunk = chars.slice(start, start + maxChars).join("").trim();
          if (chunk) output.push(chunk);
        }
        continue;
      }
      const candidate = buffer.length ? [...buffer, "\n", ...chars] : chars;
      if (buffer.length && candidate.length > maxChars) {
        output.push(buffer.join("").trim());
        const tail = buffer.slice(-overlap).join("").trim();
        buffer = tail ? [...Array.from(tail), "\n", ...chars] : chars;
      } else {
        buffer = candidate;
      }
    }
  }
  if (buffer.length) output.push(buffer.join("").trim());
  return output.filter(Boolean);
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
  // 摘要截断与 Python text[:240] 同为码点口径。
  const summary = record.summary || Array.from(normalized).slice(0, 240).join("");
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
