import { toMindNoteReadResponse, type MindNoteRow } from '../mind-notes-read.js'

export type MindNotePersistenceRow = MindNoteRow & {
  content_plain: string
  origin: string
}

/** Mind Undo 依赖的快照字段与 Python node_snapshot 保持一致。 */
export function mindNoteUndoSnapshot(row: MindNotePersistenceRow): Record<string, unknown> {
  const response = toMindNoteReadResponse(row)
  return {
    id: response.id,
    kind: response.kind,
    title: response.title,
    content_md: response.contentMd,
    content_plain: row.content_plain,
    color: response.color,
    ref_type: response.refType,
    ref_id: response.refId,
    ref_snapshot: response.refSnapshot,
    origin: row.origin,
    captured_at: response.capturedAt,
    version: response.version,
    deleted_at: response.deletedAt,
  }
}
