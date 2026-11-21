import type { DesktopAppearancePreferences, DesktopImGroupSettingsPatch as CoreDesktopImGroupSettingsPatch } from '@gugu/core/desktop'
import type { ImGroupAttentionMode, ImGroupReplyMode } from '@gugu/core/im/group-settings'

export type DesktopImPlatformKey = 'feishu' | 'qq' | 'wechat'
export type DesktopImPairingAction = 'status' | 'enable' | 'disable'
/** QQ、飞书与 Telegram 共用 Core 的群设置 IPC 契约。 */
export type DesktopImGroupSettingsPatch = CoreDesktopImGroupSettingsPatch

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
  groupReplyMode?: ImGroupReplyMode
  groupAttentionMode?: ImGroupAttentionMode
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
  updateGroupSettings?(patch: DesktopImGroupSettingsPatch): Promise<DesktopImPairingStatus>
  setPrivateStreaming?(enabled: boolean): Promise<DesktopImPairingStatus>
}

export interface DesktopQqImPairingApi extends DesktopImPairingApi {
  updateGroupSettings(patch: DesktopImGroupSettingsPatch): Promise<DesktopImPairingStatus>
  setMessageFormat(scope: 'group' | 'private', format: 'compat' | 'markdown'): Promise<DesktopImPairingStatus>
  setPrivateStreaming(enabled: boolean): Promise<DesktopImPairingStatus>
  setGroupReplyMode(mode: ImGroupReplyMode): Promise<DesktopImPairingStatus>
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
  telegram?: { status(): Promise<DesktopImPairingStatus>; updateGroupSettings(patch: DesktopImGroupSettingsPatch): Promise<DesktopImPairingStatus>; setPrivateStreaming(enabled: boolean): Promise<DesktopImPairingStatus> }
  appearance(): Promise<DesktopAppearancePreferences>
  updateAppearance(patch: Partial<DesktopAppearancePreferences>): Promise<DesktopAppearancePreferences>
}
