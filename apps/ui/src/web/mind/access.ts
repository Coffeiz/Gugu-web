import { del, get, patch, post } from '@/api/client'
import type { MindNote } from '@/services/api'
import type { MindAccess } from '@/services/mindAccess'

export const webMindAccess: MindAccess = {
  listNotes: (limit = 50, offset = 0) => get(`/mind/notes?limit=${limit}&offset=${offset}`),
  getNote: id => get(`/mind/notes/${id}`),
  createNote: data => post('/mind/notes', data),
  updateNote: (id, data, meta) => patch(`/mind/notes/${id}`, data, meta),
  deleteNote: (id, meta) => del(`/mind/notes/${id}`, meta),
  refSuggest: (query, limit = 6, disk = false) =>
    get(`/mind/ref-suggest?q=${encodeURIComponent(query)}&limit=${limit}${disk ? '&disk=1' : ''}`),
  canvasNoteLocation: id => get(`/mind/nodes/${id}/canvas-location`),
  listCanvases: () => get('/mind/canvases'),
  createCanvas: (data = {}) => post('/mind/canvases', data),
  updateCanvas: (id, data) => patch(`/mind/canvases/${id}`, data),
  deleteCanvas: id => del(`/mind/canvases/${id}`),
  listCanvasItems: id => get(`/mind/canvases/${id}/items`),
  addCanvasItem: (id, data, meta) => post(`/mind/canvases/${id}/items`, data, meta),
  async addFileReferenceToCanvas(id, fileRefId, position) {
    const node = await post<MindNote>('/mind/nodes/ref', { refType: 'file', refId: fileRefId })
    return webMindAccess.addCanvasItem(id, { nodeId: node.id, ...position })
  },
  createCanvasNote: (id, data) => post(`/mind/canvases/${id}/notes`, data),
  updateCanvasNote: (id, data, meta) => patch(`/mind/nodes/${id}`, data, meta),
  updateCanvasItem: (canvasId, itemId, data, meta) => patch(`/mind/canvases/${canvasId}/items/${itemId}`, data, meta),
  bringCanvasItemToFront: (canvasId, itemId, data, meta) => post(`/mind/canvases/${canvasId}/items/${itemId}/bring-to-front`, data, meta),
  removeCanvasItem: (canvasId, itemId, meta) => del(`/mind/canvases/${canvasId}/items/${itemId}`, meta),
  listCanvasRelations: id => get(`/mind/canvases/${id}/relations`),
  createRelation: (canvasId, srcNodeId, dstNodeId, allowParallel = false) =>
    post('/mind/relations', { canvasId, srcNodeId, dstNodeId, allowParallel }),
  deleteRelation: (canvasId, id) => del(`/mind/canvases/${canvasId}/relations/${id}`),
  createRefNode: (refType, refId, meta) => post('/mind/nodes/ref', { refType, refId }, meta),
}
