import type { RagDocument, RagSearchScope } from "../../../../packages/contracts/src/rag.ts";
import { buildDocuments, type SourceAdapter, validScope } from "./base.ts";

export type FileSourceRecord = {
  id: string | number;
  display_name: string;
  ext?: string;
  relative_path?: string;
  mime_type?: string;
  project_id?: string | number | null;
  folder_id?: string | number | null;
  content?: string;
  summary?: string;
  document_version: string;
  updated_at?: string;
  scope: RagSearchScope;
};

/** 文件适配器只接受已完成业务权限校验的记录，不把内部存储路径写入正文。 */
export const fileAdapter: SourceAdapter<FileSourceRecord> = {
  sourceType: "file",
  toDocuments(records): RagDocument[] {
    return records.flatMap((record) => {
      if (record.id === null || record.id === undefined || !record.display_name || !validScope(record.scope)) return [];
      const text = [
        `文件：${record.display_name}`,
        record.ext ? `类型：${record.ext}` : "",
        record.relative_path ? `相对路径：${record.relative_path}` : "",
        record.content || "",
      ].filter(Boolean).join("\n");
      return buildDocuments({
        id: String(record.id), source_type: "file", scope: record.scope,
        title: record.display_name, summary: record.summary,
        content: text, document_version: record.document_version,
        updated_at: record.updated_at,
        metadata: {
          mime_type: record.mime_type || "",
          project_id: record.project_id == null ? "" : String(record.project_id),
          folder_id: record.folder_id == null ? "" : String(record.folder_id),
        },
      });
    });
  },
};
