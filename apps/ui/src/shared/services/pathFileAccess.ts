import { hasInjectionContext, inject, type InjectionKey } from 'vue'
import { pathFilesApi } from '@/services/api'

export interface PathFileAccess {
  reference: typeof pathFilesApi.reference
  entries: typeof pathFilesApi.entries
  contentUrl: typeof pathFilesApi.contentUrl
  thumbnailUrl: typeof pathFilesApi.thumbnailUrl
  systemReferenceUrl?: (reference: string, thumbnail?: boolean) => string
  createFolder: typeof pathFilesApi.createFolder
  move: typeof pathFilesApi.move
  copy: typeof pathFilesApi.copy
  moveToTrash: typeof pathFilesApi.moveToTrash
  upload: (...args: Parameters<typeof pathFilesApi.upload>) => Promise<unknown>
  saveText: (...args: Parameters<typeof pathFilesApi.saveText>) => Promise<unknown>
  download: (...args: Parameters<typeof pathFilesApi.download>) => Promise<unknown>
}

export const pathFileAccessKey: InjectionKey<PathFileAccess> = Symbol('pathFileAccess')

export function usePathFileAccess(): PathFileAccess {
  return hasInjectionContext() ? inject(pathFileAccessKey, pathFilesApi) : pathFilesApi
}
