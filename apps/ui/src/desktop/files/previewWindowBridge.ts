import type { PreviewWindowBridge } from '../../../../desktop/src/shared/preview-window'
import { isFloatingPreviewable, isTextFallbackCandidate, type PreviewFile } from '@/stores/preview'
import { showAppError } from '@/composables/core/useAppToast'

export const previewWindowBridge = typeof window === 'undefined' ? undefined
  : (window as Window & { guguPreviewWindow?: PreviewWindowBridge }).guguPreviewWindow

export function openPlatformPreview(file: PreviewFile): boolean {
  const target = file.workspaceFile
  if (!previewWindowBridge || !target || typeof target.directoryId !== 'string'
    || !(isFloatingPreviewable(file.ext, file.mimeType) || isTextFallbackCandidate(file.ext, file.mimeType))) return false

  void previewWindowBridge.open({
    workspaceFile: { ...target, directoryId: target.directoryId },
    displayName: file.displayName ?? target.relativePath.split('/').at(-1) ?? '',
    ext: file.ext ?? '',
    mimeType: file.mimeType,
    sizeBytes: typeof file.sizeBytes === 'number' ? file.sizeBytes : undefined,
  }).then(reply => {
    if (reply.ok === false) showAppError(reply.error.message)
  }).catch(() => showAppError('无法打开文件预览'))
  return true
}
