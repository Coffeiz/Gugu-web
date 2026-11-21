import type { DesktopProjectDetails, DesktopReply } from '@gugu/core/desktop'

export const projectWindowChannels = {
  open: 'gugu:project-window:open',
  prepareClose: 'gugu:project-window:prepare-close',
  close: 'gugu:project-window:close',
  closed: 'gugu:project-window:closed',
  updated: 'gugu:project-window:updated',
} as const

export interface ProjectWindowBridge {
  open(id: number): Promise<DesktopReply<null>>
  close(): Promise<DesktopReply<null>>
  onPrepareClose(callback: () => void): () => void
  onUpdated(callback: (project: DesktopProjectDetails) => void): () => void
  onClosed(callback: () => void): () => void
}
