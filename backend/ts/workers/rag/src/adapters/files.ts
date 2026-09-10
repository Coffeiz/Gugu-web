import type { RagDocument, RagSearchScope } from "../../../../packages/contracts/src/rag.ts";
import { buildDocuments, type SourceAdapter, validScope } from "./base.ts";

export type FileSourceRecord = {
  id: string | number;
  /** 文件显示名（record 协议字段 title）。 */
  title: string;
  /** 文件扩展名；进入「类型：」头部行。 */
  ext?: string;
  mime_type?: string;
  project_id?: string | number | null;
  folder_id?: string | number | null;
  /** 文件所属空间（如有）；进入「空间：」头部行。 */
  space?: string;
  /** 文件业务阶段名（如有）；进入「阶段：」头部行。 */
  stage_name?: string;
  /** 已抽取的文件正文；抽取失败留空，保留元数据索引不伪造正文。 */
  content?: string;
  document_version?: string;
  /** 稳定版本输入：(id, 业务版本, 更新时间 isoformat)。 */
  version_parts?: (string | number)[];
  updated_at?: string;
  scope: RagSearchScope;
};

/** 文件适配器只接受已完成业务权限校验的记录，不把内部存储路径写入正文。 */
export const fileAdapter: SourceAdapter<FileSourceRecord> = {
  sourceType: "file",
  toDocuments(records): RagDocument[] {
    return records.flatMap((record) => {
      if (record.id === null || record.id === undefined || !validScope(record.scope)) return [];
      const text = [
        `文件：${record.title}`,
        record.ext ? `类型：${record.ext}` : "",
        record.space ? `空间：${record.space}` : "",
        record.stage_name ? `阶段：${record.stage_name}` : "",
        record.content || "",
      ].filter(Boolean).join("\n");
      return buildDocuments({
        id: String(record.id), source_type: "file", scope: record.scope,
        title: record.title,
        content: text, document_version: record.document_version ?? "",
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
