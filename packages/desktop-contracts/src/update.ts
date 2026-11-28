import type { DesktopReply } from '@gugu/core/desktop'

export const desktopUpdateChannels = {
  command: 'gugu:desktop-update:command',
  changed: 'gugu:desktop-update:changed',
} as const

export type DesktopUpdateCommand = 'status' | 'check' | 'download' | 'install'
export interface DesktopUpdateStatus {
  state: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'
  currentVersion: string
  version?: string
  progress?: number
}

export interface DesktopUpdateBridge {
  command(command: DesktopUpdateCommand): Promise<DesktopReply<DesktopUpdateStatus>>
  onStatusChanged(listener: (status: DesktopUpdateStatus) => void): () => void
}
