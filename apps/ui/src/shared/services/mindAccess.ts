import { hasInjectionContext, inject, type InjectionKey } from 'vue'
import type { RequestMeta } from '@/api/client'
import type { MindCanvas, MindCanvasItem, MindCanvasNoteCreate, MindNote, MindNoteCreate, MindNoteUpdate, MindRefSuggestItem, MindRelation } from './api'

type CanvasItemFields = Partial<Pick<MindCanvasItem, 'x' | 'y' | 'w' | 'h' | 'z' | 'collapsed' | 'data'>>
type CanvasPosition = { x: number; y: number; z: number }

export interface MindAccess {
  listNotes(limit?: number, offset?: number): Promise<MindNote[]>
  getNote(id: number): Promise<MindNote>
  createNote(data: MindNoteCreate): Promise<MindNote>
  updateNote(id: number, data: MindNoteUpdate, meta?: RequestMeta): Promise<MindNote>
  deleteNote(id: number, meta?: RequestMeta): Promise<unknown>
  refSuggest(query: string, limit?: number, disk?: boolean): Promise<MindRefSuggestItem[]>
  canvasNoteLocation(nodeId: number): Promise<{ canvasId: number }>
  listCanvases(): Promise<MindCanvas[]>
  createCanvas(data?: { title?: string; projectId?: number | null }): Promise<MindCanvas>
  updateCanvas(id: number, data: { title?: string; data?: Record<string, unknown> }): Promise<MindCanvas>
  deleteCanvas(id: number): Promise<unknown>
  listCanvasItems(id: number): Promise<MindCanvasItem[]>
  addCanvasItem(id: number, data: CanvasItemFields & { nodeId: number }, meta?: RequestMeta): Promise<MindCanvasItem>
  addFileReferenceToCanvas(id: number, fileRefId: string, position: CanvasPosition): Promise<MindCanvasItem>
  createCanvasNote(id: number, data: MindCanvasNoteCreate): Promise<MindCanvasItem>
  updateCanvasNote(id: number, data: MindNoteUpdate, meta?: RequestMeta): Promise<MindNote>
  updateCanvasItem(canvasId: number, itemId: number, data: CanvasItemFields, meta?: RequestMeta): Promise<MindCanvasItem>
  bringCanvasItemToFront(canvasId: number, itemId: number, data: Pick<CanvasPosition, 'x' | 'y'>, meta?: RequestMeta): Promise<MindCanvasItem>
  removeCanvasItem(canvasId: number, itemId: number, meta?: RequestMeta): Promise<unknown>
  listCanvasRelations(id: number): Promise<MindRelation[]>
  createRelation(canvasId: number, srcNodeId: number, dstNodeId: number, allowParallel?: boolean): Promise<MindRelation>
  deleteRelation(canvasId: number, id: number): Promise<unknown>
  createRefNode(refType: 'project' | 'event', refId: number, meta?: RequestMeta): Promise<MindNote>
}

export const mindAccessKey: InjectionKey<MindAccess> = Symbol('mindAccess')

export function useMindAccess() {
  const access = hasInjectionContext() ? inject(mindAccessKey, null) : null
  if (!access) throw new Error('笔记与画布接口未装配')
  return access
}
