import { inject, type InjectionKey } from 'vue'
import type { PathFileRef } from './api'

type LocalDirectory = Extract<PathFileRef['directoryId'], string>

type FileOpenAccess = {
  canBatchDownload?: boolean
  revealLocalEntry?(directoryId: LocalDirectory, path: string): Promise<unknown>
  startNativeDrag?(directoryId: LocalDirectory, path: string, preview?: string): Promise<unknown>
  canOpenInSystem(file: PathFileRef | undefined): boolean
  openInSystem(file: PathFileRef): Promise<void>
  createDroppedReference?(file: File): Promise<{ type: 'file'; id: string; label: string }>
  openDroppedReference?(id: string): Promise<null>
  getOpenPreference(): 'preview' | 'system'
}

export const fileOpenAccessKey: InjectionKey<FileOpenAccess> = Symbol('fileOpenAccess')

export function useFileOpenAccess() {
  return inject(fileOpenAccessKey, null)
}
