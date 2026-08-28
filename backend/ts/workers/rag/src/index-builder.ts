import type { RagDocument, RagSourceBatch, RagSourceRecord } from "../../../packages/contracts/src/rag.ts";
import { buildDocuments } from "./adapters/base.ts";
import { canvasAdapter, type CanvasSourceRecord } from "./adapters/canvas.ts";
import { conversationAdapter, type ConversationSourceRecord } from "./adapters/conversations.ts";
import { fileAdapter, type FileSourceRecord } from "./adapters/files.ts";

export type { RagSourceBatch } from "../../../packages/contracts/src/rag.ts";

function buildGenericDocuments(records: readonly RagSourceRecord[]): RagDocument[] {
  return records.flatMap((record) => {
    if (!record.id || !record.source_type || !record.title || !record.scope?.scope_type || !record.scope?.scope_id) return [];
    return buildDocuments(record);
  });
}

/** 来源适配器的唯一组合入口；调用方不得自行拼接来源文本。 */
export function buildSourceDocuments(batch: RagSourceBatch): RagDocument[] {
  return [
    ...buildGenericDocuments((batch.memory || []) as RagSourceRecord[]),
    ...buildGenericDocuments((batch.project || []) as RagSourceRecord[]),
    ...fileAdapter.toDocuments((batch.files || []) as FileSourceRecord[]),
    ...buildGenericDocuments((batch.note || []) as RagSourceRecord[]),
    ...canvasAdapter.toDocuments((batch.canvas || []) as CanvasSourceRecord[]),
    ...buildGenericDocuments((batch.calendar || []) as RagSourceRecord[]),
    ...buildGenericDocuments((batch.scheduled_task || []) as RagSourceRecord[]),
    ...conversationAdapter.toDocuments((batch.conversations || []) as ConversationSourceRecord[]),
    ...buildGenericDocuments((batch.knowledge || []) as RagSourceRecord[]),
  ];
}
