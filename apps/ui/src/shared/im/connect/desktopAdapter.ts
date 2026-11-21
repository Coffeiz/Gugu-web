import type { DesktopAppearancePreferences } from '@gugu/core/desktop'

export type DesktopImPlatformKey = 'feishu' | 'qq' | 'wechat'
export type DesktopImPairingAction = 'status' | 'enable' | 'disable'

export interface DesktopImPairingStatus {
  configured: boolean
  enabled: boolean
  bound?: boolean
  detail?: string
  connectionState?: string
  privateMessageFormat?: 'compat' | 'markdown'
  groupMessageFormat?: 'compat' | 'markdown'
  privateStreamingEnabled?: boolean
  groupChatEnabled?: boolean
  groupReplyMode?: 'reply_mentions' | 'reply_all' | 'record_only'
  groupHistorySearchEnabled?: boolean
  groupWebToolsEnabled?: boolean
  groupProviderSearchEnabled?: boolean
  groupOwnerMemoryEnabled?: boolean
  groupMemoryEnabled?: boolean
  memberMemoryEnabled?: boolean
}

export interface DesktopImPairingApi {
  status(action?: DesktopImPairingAction): Promise<DesktopImPairingStatus>
  start(): Promise<{ task_id?: string; poll_id?: string; scan_url: string }>
  poll(taskId: string): Promise<{ status: string; reason?: string }>
}

export interface DesktopQqImPairingApi extends DesktopImPairingApi {
  setMessageFormat(scope: 'group' | 'private', format: 'compat' | 'markdown'): Promise<DesktopImPairingStatus>
  setPrivateStreaming(enabled: boolean): Promise<DesktopImPairingStatus>
  setGroupReplyMode(mode: 'reply_mentions' | 'reply_all' | 'record_only'): Promise<DesktopImPairingStatus>
  setGroupWebTools(enabled: boolean): Promise<DesktopImPairingStatus>
  setGroupProviderSearch(enabled: boolean): Promise<DesktopImPairingStatus>
  setGroupHistorySearch(enabled: boolean): Promise<DesktopImPairingStatus>
  setGroupOwnerMemory(enabled: boolean): Promise<DesktopImPairingStatus>
  setGroupMemory(enabled: boolean): Promise<DesktopImPairingStatus>
  setMemberMemory(enabled: boolean): Promise<DesktopImPairingStatus>
  setGroupChat(enabled: boolean): Promise<DesktopImPairingStatus>
  unbind(): Promise<DesktopImPairingStatus>
  bindingCode(): Promise<{ code: string; expires_in: number }>
}

export interface DesktopImSettingsAdapter {
  pairings: Partial<Record<DesktopImPlatformKey, DesktopImPairingApi>>
  qq?: DesktopQqImPairingApi
  appearance(): Promise<DesktopAppearancePreferences>
  updateAppearance(patch: Partial<DesktopAppearancePreferences>): Promise<DesktopAppearancePreferences>
}
