import { ref } from 'vue'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { desktopData } from '../bridge'
import type { CanvasItemRow, CanvasRow } from '../bridge'

type Perform = (action: () => Promise<void>) => Promise<void>

/** 桌面本地画布元数据的读取与写入流程。 */
export function useDesktopCanvases(options: {
  perform: Perform
  refresh: () => Promise<void>
  refreshHistory: () => Promise<void>
}) {
  const canvases = ref<CanvasRow[]>([])
  const title = ref('')
  const editingCanvas = ref<CanvasRow | null>(null)
  const editedTitle = ref('')
  const selectedCanvasId = ref<number | null>(null)
  const items = ref<CanvasItemRow[]>([])
  const noteContent = ref('')
  const editingItem = ref<CanvasItemRow | null>(null)
  const editedNoteContent = ref('')

  async function setRows(rows: CanvasRow[]) {
    canvases.value = rows
    if (!rows.some(row => row.id === selectedCanvasId.value)) selectedCanvasId.value = rows[0]?.id ?? null
    await loadItems()
  }

  async function loadItems() {
    const canvasId = selectedCanvasId.value
    items.value = canvasId === null ? [] : await desktopData.canvasItems(canvasId)
  }

  function select(canvas: CanvasRow) {
    return options.perform(async () => {
      selectedCanvasId.value = canvas.id
      await loadItems()
    })
  }

  function createNote() {
    return options.perform(async () => {
      const canvasId = selectedCanvasId.value
      if (canvasId === null) return
      await desktopData.createCanvasNote(canvasId, noteContent.value, 'amber', items.value.length * 280, 0)
      noteContent.value = ''
      await options.refresh()
      await options.refreshHistory()
    })
  }

  function updateNote() {
    return options.perform(async () => {
      const item = editingItem.value
      if (!item) return
      await desktopData.updateCanvasNote(item.node.id, { version: item.node.version, contentMd: editedNoteContent.value })
      editingItem.value = null
      await options.refresh()
      await options.refreshHistory()
    })
  }

  function moveItem(item: CanvasItemRow, direction: 'left' | 'right' | 'up' | 'down') {
    return options.perform(async () => {
      const canvasId = selectedCanvasId.value
      if (canvasId === null) return
      const offset = direction === 'left' ? { x: -40, y: 0 }
        : direction === 'right' ? { x: 40, y: 0 }
          : direction === 'up' ? { x: 0, y: -40 } : { x: 0, y: 40 }
      await desktopData.updateCanvasItem(canvasId, item.id, { x: item.x + offset.x, y: item.y + offset.y })
      await options.refresh()
      await options.refreshHistory()
    })
  }

  function removeItem(item: CanvasItemRow) {
    return options.perform(async () => {
      const canvasId = selectedCanvasId.value
      if (canvasId === null) return
      const confirmed = await confirmDialog({
        title: '从画布移除便签',
        message: '便签将从当前画布移除，内容保留在便签列表中，可通过撤销恢复。',
        tone: 'danger',
        confirmText: '从画布移除',
      })
      if (!confirmed) return
      await desktopData.deleteCanvasItem(canvasId, item.id)
      await options.refresh()
      await options.refreshHistory()
    })
  }

  function startEdit(canvas: CanvasRow) {
    editingCanvas.value = canvas
    editedTitle.value = canvas.title
  }

  function create() {
    return options.perform(async () => {
      await desktopData.createCanvas(title.value)
      title.value = ''
      await options.refresh()
      await options.refreshHistory()
    })
  }

  function update() {
    return options.perform(async () => {
      const canvas = editingCanvas.value
      if (!canvas) return
      await desktopData.updateCanvas(canvas.id, { title: editedTitle.value })
      editingCanvas.value = null
      await options.refresh()
      await options.refreshHistory()
    })
  }

  function remove(canvas: CanvasRow) {
    return options.perform(async () => {
      const confirmed = await confirmDialog({
        title: '删除画布',
        message: `确定删除画布“${canvas.title}”吗？画布和其中的视图会进入已删除状态，可通过撤销恢复。`,
        tone: 'danger',
        confirmText: '删除画布',
      })
      if (!confirmed) return
      await desktopData.deleteCanvas(canvas.id)
      await options.refresh()
      await options.refreshHistory()
    })
  }

  return {
    canvases, title, editingCanvas, editedTitle, setRows, startEdit, create, update, remove,
    selectedCanvasId, items, noteContent, editingItem, editedNoteContent,
    select, createNote, updateNote, moveItem, removeItem,
  }
}
