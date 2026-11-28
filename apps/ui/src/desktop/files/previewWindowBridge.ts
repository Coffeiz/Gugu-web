import type { DesktopPreviewRequest, PreviewWindowBridge } from '@gugu/desktop-contracts'
import { isFloatingPreviewable, isTextFallbackCandidate, type PreviewFile } from '@/stores/preview'
import { showAppError } from '@/composables/core/useAppToast'

export const previewWindowBridge = typeof window === 'undefined' ? undefined
  : (window as Window & { guguPreviewWindow?: PreviewWindowBridge }).guguPreviewWindow

export function openPlatformPreview(file: PreviewFile): boolean {
  const target = file.workspaceFile
  if (!previewWindowBridge
    || !(isFloatingPreviewable(file.ext, file.mimeType) || isTextFallbackCandidate(file.ext, file.mimeType))) return false

  let request: DesktopPreviewRequest
  if (target && typeof target.directoryId === 'string') {
    request = {
      workspaceFile: { ...target, directoryId: target.directoryId },
      displayName: file.displayName ?? target.relativePath.split('/').at(-1) ?? '',
      ext: file.ext ?? '',
      mimeType: file.mimeType,
      sizeBytes: typeof file.sizeBytes === 'number' ? file.sizeBytes : undefined,
    }
  } else if (typeof file.attach_id === 'string' && file.attach_id) request = { attachmentId: file.attach_id }
  else if (file.chatLibraryPath && /^\/(?:personal|project|workspace)\//u.test(file.chatLibraryPath))
    request = { libraryPath: file.chatLibraryPath }
  else return false

  void previewWindowBridge.open(request).then(reply => {
    if (reply.ok === false) showAppError(reply.error.message)
  }).catch(() => showAppError('无法打开文件预览'))
  return true
}
