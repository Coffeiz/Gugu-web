import type { RagDocument, RagSearchScope } from "../../../../packages/contracts/src/rag.ts";
import { buildDocuments, type SourceAdapter, validScope } from "./base.ts";

export type FileSourceRecord = {
  id: string | number;
  /** 文件显示名（record 协议字段 title）。 */
  title: string;
  /** 文件扩展名；保留作来源元数据，不参与文件名索引。 */
  ext?: string;
  mime_type?: string;
  project_id?: string | number | null;
  folder_id?: string | number | null;
  /** 文件所属空间（如有）；保留作来源元数据，不参与文件名索引。 */
  space?: string;
  /** 文件业务阶段名（如有）；保留作来源元数据，不参与文件名索引。 */
  stage_name?: string;
  /** 兼容旧协议字段；文件索引不读取或使用正文。 */
  content?: string;
  document_version?: string;
  /** 稳定版本输入：(id, 业务版本, 更新时间 isoformat)。 */
  version_parts?: (string | number)[];
  updated_at?: string;
  scope: RagSearchScope;
};

/** 文件适配器只接受已完成业务权限校验的记录，只索引文件名，不把正文或存储路径写入索引。 */
export const fileAdapter: SourceAdapter<FileSourceRecord> = {
  sourceType: "file",
  toDocuments(records): RagDocument[] {
    return records.flatMap((record) => {
      if (record.id === null || record.id === undefined || !validScope(record.scope)) return [];
      const title = String(record.title || "未命名").trim() || "未命名";
      return buildDocuments({
        id: String(record.id), source_type: "file", scope: record.scope,
        title,
        // 复用统一单文档构造器，但正文只放文件名，确保每个文件只有一个 chunk。
        content: title, summary: "", document_version: record.document_version ?? "",
        version_parts: record.version_parts,
        updated_at: record.updated_at,
        metadata: {
          file_id: String(record.id),
          mime_type: record.mime_type || "",
          project_id: record.project_id == null ? "" : String(record.project_id),
          folder_id: record.folder_id == null ? "" : String(record.folder_id),
          space: record.space || "",
        },
      });
    });
  },
};
