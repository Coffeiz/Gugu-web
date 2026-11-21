import type { DesktopFileDirectory, DesktopReply } from '@gugu/core/desktop'
import { isTextExt } from '../../../ui/src/shared/utils/filePreviewTypes.js'

export interface DesktopPreviewMetadata {
  displayName: string
  ext: string
  mimeType?: string | null
  sizeBytes?: number
}

export interface DesktopPreviewFile extends DesktopPreviewMetadata {
  workspaceFile: { directoryId: DesktopFileDirectory; relativePath: string; identity?: string }
}

export type DesktopPreviewWindowFile = DesktopPreviewFile | (DesktopPreviewMetadata & { contentUrl: string })

/** 原生窗口创建前按文档用途确定比例，并统一缩放到所在屏幕的可用范围。 */
export function desktopPreviewBounds(
  file: Pick<DesktopPreviewMetadata, 'ext' | 'mimeType'>,
  area: { x: number; y: number; width: number; height: number },
) {
  const ext = file.ext.toLowerCase()
  const [preferredWidth, preferredHeight] = ['csv', 'xlsx', 'xls'].includes(ext) ? [1080, 660]
    : ['ppt', 'pptx'].includes(ext) ? [1000, 620]
    : ['doc', 'docx', 'pdf', 'md', 'markdown', 'rtf'].includes(ext) || isTextExt(ext, file.mimeType) ? [680, 850]
    : [900, 670]
  const scale = Math.min(1, area.width / preferredWidth, area.height / preferredHeight)
  const width = Math.floor(preferredWidth * scale)
  const height = Math.floor(preferredHeight * scale)
  return {
    width, height, minWidth: Math.min(360, width), minHeight: Math.min(260, height),
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
  }
}

export const previewWindowChannels = {
  open: 'gugu:preview-window:open',
  read: 'gugu:preview-window:read',
  close: 'gugu:preview-window:close',
  reveal: 'gugu:preview-window:reveal',
  state: 'gugu:preview-window:state',
  stateChanged: 'gugu:preview-window:state-changed',
} as const

export interface DesktopPreviewWindowState { fullscreen: boolean; pinned: boolean }
export type DesktopPreviewWindowControl = 'read' | 'fullscreen' | 'pin'

export interface PreviewWindowBridge {
  open(file: DesktopPreviewFile): Promise<DesktopReply<null>>
  read(): Promise<DesktopReply<DesktopPreviewWindowFile>>
  close(): Promise<DesktopReply<null>>
  reveal(): Promise<DesktopReply<null>>
  state(action: DesktopPreviewWindowControl, enabled?: boolean): Promise<DesktopReply<DesktopPreviewWindowState>>
  onStateChanged(callback: (state: DesktopPreviewWindowState) => void): () => void
}
