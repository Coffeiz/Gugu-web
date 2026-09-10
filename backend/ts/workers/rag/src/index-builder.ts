import type { RagDocument, RagSourceBatch, RagSourceRecord } from "../../../packages/contracts/src/rag.ts";
import { buildDocuments, validScope } from "./adapters/base.ts";
import { calendarAdapter, type CalendarSourceRecord } from "./adapters/calendar.ts";
import { canvasAdapter, type CanvasSourceRecord } from "./adapters/canvas.ts";
import { conversationAdapter, type ConversationSourceRecord } from "./adapters/conversations.ts";
import { fileAdapter, type FileSourceRecord } from "./adapters/files.ts";
import { noteAdapter, type NoteSourceRecord } from "./adapters/note.ts";
import { scheduledTaskAdapter } from "./adapters/scheduled-tasks.ts";

export type { RagSourceBatch } from "../../../packages/contracts/src/rag.ts";

function buildGenericDocuments(records: readonly RagSourceRecord[]): RagDocument[] {
  return records.flatMap((record) => {
    if (record.id === null || record.id === undefined || !record.source_type || !record.title
      || !validScope(record.scope)) return [];
    return buildDocuments(record);
  });
}

/** 来源适配器的唯一组合入口；调用方不得自行拼接来源文本。 */
export function buildSourceDocuments(batch: RagSourceBatch): RagDocument[] {
  return [
    ...buildGenericDocuments((batch.memory || []) as RagSourceRecord[]),
    ...buildGenericDocuments((batch.project || []) as RagSourceRecord[]),
    ...fileAdapter.toDocuments((batch.files || []) as FileSourceRecord[]),
    ...noteAdapter.toDocuments((batch.note || []) as NoteSourceRecord[]),
    ...canvasAdapter.toDocuments((batch.canvas || []) as CanvasSourceRecord[]),
    ...calendarAdapter.toDocuments((batch.calendar || []) as unknown as Parameters<typeof calendarAdapter.toDocuments>[0]),
    ...scheduledTaskAdapter.toDocuments((batch.scheduled_task || []) as unknown as Parameters<typeof scheduledTaskAdapter.toDocuments>[0]),
    ...conversationAdapter.toDocuments((batch.conversations || []) as ConversationSourceRecord[]),
    ...buildGenericDocuments((batch.knowledge || []) as RagSourceRecord[]),
  ];
}
