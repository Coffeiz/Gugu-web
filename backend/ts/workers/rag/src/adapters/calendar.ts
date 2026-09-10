import type { RagDocument, RagSearchScope } from "../../../../packages/contracts/src/rag.ts";
import { buildDocuments, type SourceAdapter, validScope } from "./base.ts";

export type CalendarSourceRecord = {
  id: string | number;
  title: string;
  date: string;
  time?: string;
  description?: string;
  project_id?: string | number | null;
  document_version?: string;
  /** 稳定版本输入：(id, 业务版本, 日期, 描述)。 */
  version_parts?: (string | number)[];
  scope: RagSearchScope;
};

/** 活动适配器：活动/日期/时间三行头部，空描述整行省略。 */
export const calendarAdapter: SourceAdapter<CalendarSourceRecord> = {
  sourceType: "calendar",
  toDocuments(records): RagDocument[] {
    return records.flatMap((record) => {
      if (record.id === null || record.id === undefined || !validScope(record.scope)) return [];
      const text = [
        `活动：${record.title}`,
        `日期：${record.date}`,
        `时间：${record.time || "全天"}`,
        record.description || "",
      ].filter(Boolean).join("\n");
      return buildDocuments({
        id: String(record.id), source_type: "calendar", scope: record.scope,
        title: record.title,
        content: text, document_version: record.document_version ?? "",
        version_parts: record.version_parts,
        metadata: {
          event_id: String(record.id),
          project_id: record.project_id == null ? "" : String(record.project_id),
        },
      });
    });
  },
};
