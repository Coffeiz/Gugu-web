import type { MindNote, MindNoteCreate } from '@/services/api'

/** 空白的新笔记只作为前端草稿存在；标题或正文有内容时才创建服务端记录。 */
export function persistMindNoteDraft(
  note: Pick<MindNote, 'capturedAt'>,
  contentMd: string,
  title: string | null,
  createNote: (data: MindNoteCreate) => Promise<MindNote>,
): Promise<MindNote> | null {
  if (!contentMd.trim() && !title?.trim()) return null
  return createNote({ contentMd, title, capturedAt: note.capturedAt })
}
