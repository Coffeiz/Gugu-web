import { hasInjectionContext, inject, type InjectionKey } from 'vue'
import { pathFilesApi } from '@/services/api'

export interface PathFileAccess {
  watchDirectoryUrl?: typeof pathFilesApi.watchDirectoryUrl
  fileRevision?: (file: Parameters<typeof pathFilesApi.contentUrl>[0], signal: AbortSignal) => Promise<string | undefined>
  downloadArchive?: typeof pathFilesApi.downloadArchive
  compressArchive?: typeof pathFilesApi.compressArchive
  extractArchive?: typeof pathFilesApi.extractArchive
  resolveRelative?: typeof pathFilesApi.resolveRelative
  resolveLibraryLink?: (url: string) => Promise<{ id: string; kind: 'file' | 'folder' } | null>
  openRelativePreview?: (href: string) => Promise<void> | undefined
  reference: typeof pathFilesApi.reference
  entries: typeof pathFilesApi.entries
  contentUrl: typeof pathFilesApi.contentUrl
  thumbnailUrl: typeof pathFilesApi.thumbnailUrl
  systemReferenceUrl?: (reference: string, thumbnail?: boolean) => string
  createFolder: typeof pathFilesApi.createFolder
  moveDropped?: (
    directoryId: string | number, relativePath: string,
    decide: (filename: string, canOverwrite: boolean) => Promise<'skip' | 'keep_both' | 'overwrite'>,
    progress: (percent: number) => void,
  ) => Promise<{ retained: number }> | undefined
  hasHistory?: typeof pathFilesApi.hasHistory
  applyHistory?: typeof pathFilesApi.applyHistory
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
