import { hasInjectionContext, inject, type InjectionKey } from 'vue'
import type { FileLibraryNavigationTarget } from '@/utils/filesNav'

export interface SearchItem {
  id: number | string
  title: string
  subtitle?: string
  date?: string
  message_id?: number
  canvas_id?: number
  enabled?: boolean
  path_file?: FileLibraryNavigationTarget['pathFile']
}
export interface SearchGroup { type: 'project' | 'file' | 'folder' | 'event' | 'client' | 'conversation' | 'note' | 'canvas_note' | 'skill' | 'mcp' | 'scheduled_task'; label: string; items: SearchItem[] }

export interface SearchAccess {
  query(queries: string[], signal?: AbortSignal): Promise<{ total: number; partial?: boolean; groups: SearchGroup[] }>
  queryNotes(query: string, signal?: AbortSignal): Promise<{
    groups: Array<{ type: string; items: Array<{ id: number | string }> }>
  }>
}

export const searchAccessKey: InjectionKey<SearchAccess> = Symbol('searchAccess')

export function useSearchAccess() {
  return hasInjectionContext() ? inject(searchAccessKey, null) : null
}
