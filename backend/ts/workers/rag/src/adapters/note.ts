import type { RagDocument, RagSearchScope } from "../../../../packages/contracts/src/rag.ts";
import { buildDocuments, type SourceAdapter, validScope } from "./base.ts";

export type NoteSourceRecord = {
  id: string | number;
  title?: string;
  content_plain?: string;
  content_md?: string;
  kind: string;
  document_version?: string;
  /** 稳定版本输入：(id, 业务版本, indexed_hash)。 */
  version_parts?: (string | number)[];
  updated_at?: string;
  scope: RagSearchScope;
};

/** 便签适配器：标题行 + 纯文本优先的正文，空标题回落「便签」。 */
export const noteAdapter: SourceAdapter<NoteSourceRecord> = {
  sourceType: "note",
  toDocuments(records): RagDocument[] {
    return records.flatMap((record) => {
      if (record.id === null || record.id === undefined || !validScope(record.scope)) return [];
      const text = [
        record.title || "",
        record.content_plain || record.content_md || "",
      ].filter(Boolean).join("\n");
      return buildDocuments({
        id: String(record.id), source_type: "note", scope: record.scope,
        title: record.title || "便签",
        content: text, document_version: record.document_version ?? "",
        version_parts: record.version_parts,
        updated_at: record.updated_at,
        metadata: {
          node_id: String(record.id),
          kind: record.kind,
        },
      });
    });
  },
};
