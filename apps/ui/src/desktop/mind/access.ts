import type { MindCanvas, MindCanvasItem, MindNote, MindRefSuggestItem, MindRelation } from '@/services/api'
import type { MindAccess } from '@/services/mindAccess'
import { desktopData, requestDesktopFile } from '../bridge/bridge'

export const desktopMindAccess: MindAccess = {
  async listNotes(limit = 50, offset = 0) {
    return (await desktopData.notes()).slice(offset, offset + limit) as MindNote[]
  },
  async getNote(id) {
    const note = (await desktopData.notes()).find(item => item.id === id)
    if (!note) throw new Error('便签不存在')
    return note as MindNote
  },
  createNote: data => desktopData.createNote(data.contentMd, data.color ?? undefined) as Promise<MindNote>,
  updateNote: (id, data) => desktopData.updateNote(id, data) as Promise<MindNote>,
  deleteNote: desktopData.deleteNote,
  async refSuggest(text, limit = 6) {
    const query = text.trim().toLocaleLowerCase()
    if (!query) return []
    const [projects, events, files] = await Promise.all([
      desktopData.projects(), desktopData.calendar(),
      requestDesktopFile({ action: 'search', query }) as Promise<MindRefSuggestItem[]>,
    ])
    return [
      ...projects.filter(item => item.name.toLocaleLowerCase().includes(query)).map(item => ({ type: 'project' as const, id: item.id, label: item.name })),
      ...files,
      ...events.filter(item => item.title.toLocaleLowerCase().includes(query)).map(item => ({ type: 'event' as const, id: item.id, label: item.title, subtitle: item.date })),
    ].slice(0, limit)
  },
  async canvasNoteLocation(id) {
    const location = await desktopData.canvasNoteLocation(id)
    if (!location) throw new Error('画布便签位置不存在')
    return location
  },
  listCanvases: () => desktopData.canvases() as Promise<MindCanvas[]>,
  createCanvas: (data = {}) => desktopData.createCanvas(data.title ?? '') as Promise<MindCanvas>,
  updateCanvas: (id, data) => desktopData.updateCanvas(id, data) as Promise<MindCanvas>,
  deleteCanvas: desktopData.deleteCanvas,
  listCanvasItems: id => desktopData.canvasItems(id) as Promise<MindCanvasItem[]>,
  addCanvasItem: (id, data) => desktopData.addCanvasItem(id, data) as Promise<MindCanvasItem>,
  addFileReferenceToCanvas: (id, fileRefId, position) =>
    desktopData.addCanvasItem(id, { fileRefId, ...position }) as Promise<MindCanvasItem>,
  createCanvasNote: (id, data) => desktopData.createCanvasNote(id, data) as Promise<MindCanvasItem>,
  updateCanvasNote: (id, data) => desktopData.updateCanvasNote(id, data) as Promise<MindNote>,
  updateCanvasItem: (canvasId, itemId, data) => desktopData.updateCanvasItem(canvasId, itemId, data) as Promise<MindCanvasItem>,
  bringCanvasItemToFront: (canvasId, itemId, data) => desktopData.bringCanvasItemToFront(canvasId, itemId, data) as Promise<MindCanvasItem>,
  removeCanvasItem: (canvasId, itemId) => desktopData.deleteCanvasItem(canvasId, itemId),
  listCanvasRelations: id => desktopData.canvasRelations(id) as Promise<MindRelation[]>,
  createRelation: (canvasId, srcNodeId, dstNodeId, allowParallel = false) =>
    desktopData.createCanvasRelation({ canvasId, srcNodeId, dstNodeId, allowParallel }) as Promise<MindRelation>,
  deleteRelation: desktopData.deleteCanvasRelation,
  createRefNode: (refType, refId) => desktopData.createRefNode(refType, refId) as Promise<MindNote>,
}
