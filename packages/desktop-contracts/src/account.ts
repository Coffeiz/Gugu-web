import type { RemoteAccountState, RemoteLoginInput } from '@gugu/auth/contracts'
import type { DesktopBridge as CoreDesktopBridge, DesktopReply } from '@gugu/core/desktop'

export interface DesktopDeviceInfo {
  deviceId: string
  platform: string
}

export interface DesktopAccountBridge {
  deviceInfo(): Promise<DesktopReply<DesktopDeviceInfo>>
  remoteAccount(): Promise<DesktopReply<RemoteAccountState>>
  remoteLogin(input: RemoteLoginInput): Promise<DesktopReply<RemoteAccountState>>
  remoteLogout(): Promise<DesktopReply<RemoteAccountState>>
}

export type DesktopBridge = CoreDesktopBridge & DesktopAccountBridge
