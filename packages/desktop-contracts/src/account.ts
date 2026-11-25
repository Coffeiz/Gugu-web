import type { RemoteAccountState, RemoteLoginInput } from '@gugu/auth/contracts'
import type { DesktopBridge as CoreDesktopBridge, DesktopReply } from '@gugu/core/desktop'

export interface DesktopAccountBridge {
  remoteAccount(): Promise<DesktopReply<RemoteAccountState>>
  remoteLogin(input: RemoteLoginInput): Promise<DesktopReply<RemoteAccountState>>
  remoteLogout(): Promise<DesktopReply<RemoteAccountState>>
}

export type DesktopBridge = CoreDesktopBridge & DesktopAccountBridge
