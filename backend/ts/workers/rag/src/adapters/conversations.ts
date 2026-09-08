import type { RagDocument, RagSearchScope } from "../../../../packages/contracts/src/rag.ts";
import { buildDocuments, type SourceAdapter, validScope } from "./base.ts";

export type ConversationSourceRecord = {
  /** 与 Python record 协议一致：summary="<会话id>:summary"，message="<消息id>"。 */
  id: string | number;
  kind: "summary" | "message";
  session_id: string | number;
  role?: string;
  /** summary 专用：会话摘要正文。 */
  summary?: string;
  /** message 专用：消息正文。 */
  content?: string;
  title?: string;
  session_source?: string;
  session_updated_at?: string;
  document_version?: string;
  /** 稳定版本输入：summary=(会话id, 更新时间, 摘要)；message=(消息id, 创建时间, 正文)。 */
  version_parts?: (string | number)[];
  updated_at?: string;
  scope: RagSearchScope;
};

const buildMetadata = (record: ConversationSourceRecord): Record<string, string | number> => {
  const metadata: Record<string, string | number> = {
    session_id: String(record.session_id),
    kind: record.kind,
    session_source: record.session_source || "",
    session_updated_at: record.session_updated_at || "",
  };
  if (record.kind === "message") {
    metadata.message_id = String(record.id);
    metadata.role = record.role ?? "";
  }
  return metadata;
};

/** 对话适配器：会话摘要与会话消息两种文档；baseline/角色过滤由收集器完成。 */
export const conversationAdapter: SourceAdapter<ConversationSourceRecord> = {
  sourceType: "conversation",
  toDocuments(records): RagDocument[] {
    return records.flatMap((record) => {
      if (record.id === null || record.id === undefined || !validScope(record.scope)) return [];
      const body = record.kind === "summary"
        ? (record.summary ?? "")
        : (record.content ?? "");
      if (!body.trim()) return [];
      if (record.kind === "message" && !record.role) return [];
      return buildDocuments({
        id: String(record.id), source_type: "conversation", scope: record.scope,
        title: record.title || "未命名",
        content: record.kind === "summary" ? `会话摘要：${body}` : `${record.role}：${body}`,
        document_version: record.document_version ?? "",
        version_parts: record.version_parts,
        updated_at: record.updated_at,
        metadata: buildMetadata(record),
      });
    });
  },
};
