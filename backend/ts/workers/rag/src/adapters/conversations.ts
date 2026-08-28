import type { RagDocument, RagSearchScope } from "../../../../packages/contracts/src/rag.ts";
import { buildDocuments, type SourceAdapter, validScope } from "./base.ts";

export type ConversationSourceRecord = {
  session_id: string | number;
  message_id: string | number;
  title?: string;
  summary?: string;
  role: string;
  content?: string;
  platform?: string;
  message_start?: string;
  message_end?: string;
  document_version: string;
  updated_at?: string;
  scope: RagSearchScope;
};

/** 对话适配器只接收摘要或稳定消息切片，完整会话仍由 read_conversation 读取。 */
export const conversationAdapter: SourceAdapter<ConversationSourceRecord> = {
  sourceType: "conversation",
  toDocuments(records): RagDocument[] {
    return records.flatMap((record) => {
      if (!record.session_id || !record.message_id || !record.content || !validScope(record.scope)) return [];
      const text = `${record.role}：${record.content}`;
      return buildDocuments({
        id: `${record.session_id}:${record.message_id}`,
        source_type: "conversation", scope: record.scope,
        title: record.title || "未命名对话", summary: record.summary,
        content: text, document_version: record.document_version,
        updated_at: record.updated_at,
        metadata: {
          session_id: String(record.session_id),
          message_id: String(record.message_id),
          role: record.role,
          platform: record.platform || "",
          message_start: record.message_start || "",
          message_end: record.message_end || "",
        },
      });
    });
  },
};
