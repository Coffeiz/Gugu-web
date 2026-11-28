import type { DesktopFileDirectory, DesktopReply } from '@gugu/core/desktop'

export interface DesktopPreviewMetadata {
  displayName: string
  ext: string
  mimeType?: string | null
  sizeBytes?: number
}

export interface DesktopPreviewFile extends DesktopPreviewMetadata {
  workspaceFile: { directoryId: DesktopFileDirectory; relativePath: string; identity?: string }
}

export type DesktopPreviewRequest = DesktopPreviewFile | { attachmentId: string } | { libraryPath: string } | { relativeHref: string }
export type DesktopPreviewWindowFile = DesktopPreviewFile | (DesktopPreviewMetadata & { contentUrl: string; canReveal?: false })

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
  open(file: DesktopPreviewRequest): Promise<DesktopReply<null>>
  read(): Promise<DesktopReply<DesktopPreviewWindowFile>>
  close(): Promise<DesktopReply<null>>
  reveal(): Promise<DesktopReply<null>>
  state(action: DesktopPreviewWindowControl, enabled?: boolean): Promise<DesktopReply<DesktopPreviewWindowState>>
  onStateChanged(callback: (state: DesktopPreviewWindowState) => void): () => void
}
