import type { RagDocument, RagSearchScope } from "../../../../packages/contracts/src/rag.ts";
import { buildDocuments, type SourceAdapter, validScope } from "./base.ts";

export type ScheduledTaskSourceRecord = {
  id: string | number;
  name: string;
  cron: string;
  enabled: boolean;
  payload?: string;
  document_version?: string;
  /** 稳定版本输入：(id, 更新时间 isoformat, cron, payload)。 */
  version_parts?: (string | number)[];
  scope: RagSearchScope;
};

/** 定时任务适配器：固定四行结构，空 payload 也保留换行（与 Python 方言一致）。 */
export const scheduledTaskAdapter: SourceAdapter<ScheduledTaskSourceRecord> = {
  sourceType: "scheduled_task",
  toDocuments(records): RagDocument[] {
    return records.flatMap((record) => {
      if (record.id === null || record.id === undefined || !validScope(record.scope)) return [];
      const text = `定时任务：${record.name}\n计划：${record.cron}\n状态：${record.enabled ? "启用" : "停用"}\n${record.payload || ""}`;
      return buildDocuments({
        id: String(record.id), source_type: "scheduled_task", scope: record.scope,
        title: record.name,
        content: text, document_version: record.document_version ?? "",
        version_parts: record.version_parts,
        metadata: {
          task_id: String(record.id),
          enabled: record.enabled,
        },
      });
    });
  },
};
