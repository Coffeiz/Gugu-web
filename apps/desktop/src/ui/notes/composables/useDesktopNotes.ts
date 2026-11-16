import { ref } from 'vue'
import { desktopData } from '@/desktop/bridge'
import type { NoteRow } from '@/desktop/bridge'
import { confirmDialog } from '@/composables/core/useConfirmDialog'

type Perform = (action: () => Promise<void>) => Promise<void>
type HistoryState = { undo: string | null; redo: string | null }

export function useDesktopNotes(perform: Perform, refresh: () => Promise<void>) {
  const notes = ref<NoteRow[]>([])
  const noteContent = ref('')
  const editingNote = ref<NoteRow | null>(null)
  const editedNoteContent = ref('')
  const history = ref<HistoryState>({ undo: null, redo: null })

  async function setRows(rows: NoteRow[]) {
    notes.value = rows
  }

  async function refreshHistory() {
    try {
      const result = await desktopData.undoPreview('desktop-mind') as {
        undo?: { operation_id?: unknown; can_undo?: boolean } | null
        redo?: { operation_id?: unknown; can_redo?: boolean } | null
      }
      history.value = {
        undo: result.undo?.can_undo && typeof result.undo.operation_id === 'string' ? result.undo.operation_id : null,
        redo: result.redo?.can_redo && typeof result.redo.operation_id === 'string' ? result.redo.operation_id : null,
      }
    } catch {
      history.value = { undo: null, redo: null }
    }
  }

  function create() {
    return perform(async () => {
      await desktopData.createNote(noteContent.value)
      noteContent.value = ''
      await refresh()
      await refreshHistory()
    })
  }

  function update() {
    return perform(async () => {
      const note = editingNote.value
      if (!note) return
      await desktopData.updateNote(note.id, { version: note.version, contentMd: editedNoteContent.value })
      editingNote.value = null
      await refresh()
      await refreshHistory()
    })
  }

  function remove(note: NoteRow) {
    return perform(async () => {
      const confirmed = await confirmDialog({
        title: '删除便签',
        message: '删除后便签将进入已删除状态，可通过撤销恢复。',
        tone: 'danger',
        confirmText: '删除便签',
      })
      if (!confirmed) return
      await desktopData.deleteNote(note.id)
      await refresh()
      await refreshHistory()
    })
  }

  function applyHistoryAction(mode: 'undo' | 'redo') {
    return perform(async () => {
      const operationId = history.value[mode]
      if (!operationId) return
      const requestId = crypto.randomUUID()
      if (mode === 'undo') await desktopData.undoApply('desktop-mind', operationId, requestId)
      else await desktopData.undoRedo('desktop-mind', operationId, requestId)
      await refresh()
      await refreshHistory()
    })
  }

  return { notes, noteContent, editingNote, editedNoteContent, history, setRows, refreshHistory, create, update, remove, applyHistoryAction }
}
