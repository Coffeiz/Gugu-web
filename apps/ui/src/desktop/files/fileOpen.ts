import { desktopData, requestDesktopFile } from '@desktop/bridge/bridge'
import type { DesktopFileDirectory } from '@gugu/core/desktop'
import type { PathFileRef } from '@/services/api'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'

const preferenceKey = 'gugu:desktop:file-open'
export type DesktopFileOpenPreference = 'preview' | 'system'

export function getDesktopFileOpenPreference(): DesktopFileOpenPreference {
  return localStorage.getItem(preferenceKey) === 'system' ? 'system' : 'preview'
}

export async function setDesktopFileOpenPreference(value: DesktopFileOpenPreference) {
  await desktopData.updateAppearance({ fileOpenPreference: value })
  localStorage.setItem(preferenceKey, value)
}

export async function syncDesktopFileOpenPreference(value: DesktopFileOpenPreference | undefined) {
  if (value) localStorage.setItem(preferenceKey, value)
  else if (localStorage.getItem(preferenceKey) === 'system') await setDesktopFileOpenPreference('system')
}

export function canOpenDesktopFile(file: PathFileRef | undefined): file is PathFileRef & { directoryId: DesktopFileDirectory } {
  return typeof file?.directoryId === 'string' && 'guguDesktop' in window
}

export async function openDesktopFile(file: PathFileRef) {
  if (!canOpenDesktopFile(file)) return
  try {
    await requestDesktopFile({ action: 'open', directoryId: file.directoryId, path: file.relativePath, identity: file.identity })
  } catch (error) {
    showAppError(errorMessage(error))
  }
}
