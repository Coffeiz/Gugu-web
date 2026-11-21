import { randomUUID } from 'node:crypto'
import { createFeishuPairing } from '@gugu/gateway/feishu'
import { createEncryptedDesktopStore } from '../../../../auth/store.js'
import { DesktopError } from '../../../../core-host.js'
import { createDesktopPairingState } from '../../pending.js'
import type { ImGroupAttentionMode, ImGroupReplyMode } from '@gugu/core/im/group-settings'
import { defaultUserBotPrivateStreamingEnabled } from '@gugu/core/im/user-bots'
import { defaultUserBotGroupSettings, updateUserBotGroupTools, userBotGroupToolFlags } from '@gugu/core/im/user-bots'

type Transport = Parameters<typeof createFeishuPairing>[0]['transport']
type Encryption = Parameters<typeof createEncryptedDesktopStore>[2]
type GroupReplyMode = ImGroupReplyMode
type GroupAttentionMode = ImGroupAttentionMode
type GroupSettingsPatch = Partial<Pick<FeishuCredential, 'groupChatEnabled' | 'groupReplyMode' | 'groupAttentionMode'
  | 'groupOwnerMemoryEnabled' | 'groupMemoryEnabled' | 'memberMemoryEnabled'>> & {
    groupWebToolsEnabled?: boolean; groupProviderSearchEnabled?: boolean; groupHistorySearchEnabled?: boolean
  }

interface FeishuCredential {
  appId: string; appSecret: string; userId: string; enabled: boolean; revision: string
  privateStreamingEnabled: boolean
  groupChatEnabled: boolean; groupReplyMode: GroupReplyMode; groupAttentionMode: GroupAttentionMode
  groupOwnerMemoryEnabled: boolean; groupMemoryEnabled: boolean; memberMemoryEnabled: boolean
  groupAllowedTools: string[]
}

function parseCredential(input: unknown) {
  if (!input || typeof input !== 'object') throw invalid()
  const values = input as Record<string, unknown>
  const { appId, appSecret, userId, enabled, revision } = values
  const defaults = defaultUserBotGroupSettings('feishu')
  const groupChatEnabled = values.groupChatEnabled ?? defaults.groupChatEnabled
  const groupReplyMode = values.groupReplyMode ?? defaults.groupReplyMode
  const groupAttentionMode = values.groupAttentionMode ?? defaults.groupAttentionMode
  const privateStreamingEnabled = values.privateStreamingEnabled ?? defaultUserBotPrivateStreamingEnabled('feishu')
  const groupOwnerMemoryEnabled = values.groupOwnerMemoryEnabled ?? defaults.groupOwnerMemoryEnabled
  const groupMemoryEnabled = values.groupMemoryEnabled ?? defaults.groupMemoryEnabled
  const memberMemoryEnabled = values.memberMemoryEnabled ?? defaults.memberMemoryEnabled
  const groupAllowedTools = values.groupAllowedTools ?? defaults.groupAllowedTools
  if (typeof appId !== 'string' || !appId || typeof appSecret !== 'string' || !appSecret
    || typeof userId !== 'string' || !userId || typeof enabled !== 'boolean'
    || typeof revision !== 'string' || !revision || typeof groupChatEnabled !== 'boolean'
    || !['reply_mentions', 'reply_all', 'record_only'].includes(String(groupReplyMode))
    || !['quiet', 'natural', 'active', 'autonomous'].includes(String(groupAttentionMode))
    || typeof groupOwnerMemoryEnabled !== 'boolean' || typeof groupMemoryEnabled !== 'boolean'
    || typeof memberMemoryEnabled !== 'boolean' || typeof privateStreamingEnabled !== 'boolean' || !Array.isArray(groupAllowedTools)
    || !groupAllowedTools.every(tool => typeof tool === 'string' && ['web_search', 'http_get', 'similar_image_search', 'send_file', 'group_context_search'].includes(tool))) throw invalid()
  return { appId, appSecret, userId, enabled, revision, groupChatEnabled, groupReplyMode, groupAttentionMode, privateStreamingEnabled,
    groupOwnerMemoryEnabled, groupMemoryEnabled, memberMemoryEnabled, groupAllowedTools } as FeishuCredential
}

function invalid() { return new DesktopError('invalid_request', '飞书连接缺少有效凭据或绑定身份') }

export function createDesktopFeishuPairing(directory: string, encryption: Encryption, ownerId: string,
  transport: Transport, onChanged?: () => Promise<void>) {
  const credentials = createEncryptedDesktopStore(directory, 'im-feishu', encryption, parseCredential)
  const state = createDesktopPairingState()
  const pairing = createFeishuPairing({
    portalBase: 'https://accounts.feishu.cn', transport, store: state.store,
    platforms: () => ['feishu'], generateId: () => randomUUID().replaceAll('-', ''),
    async saveBot(_owner, appId, appSecret, userId) {
      const previous = await credentials.read()
      await credentials.write(parseCredential({ ...previous, appId, appSecret, userId, enabled: true, revision: randomUUID() }))
      await onChanged?.()
      return { id: 1, name: '我的飞书', app_id: appId }
    },
  })

  async function status() {
    const current = await credentials.read()
    return { configured: Boolean(current), enabled: current?.enabled === true, ...(current ? {
      bound: true, groupChatEnabled: current.groupChatEnabled, groupReplyMode: current.groupReplyMode,
      privateStreamingEnabled: current.privateStreamingEnabled,
      groupAttentionMode: current.groupAttentionMode, groupOwnerMemoryEnabled: current.groupOwnerMemoryEnabled,
      groupMemoryEnabled: current.groupMemoryEnabled, memberMemoryEnabled: current.memberMemoryEnabled,
      ...userBotGroupToolFlags(current.groupAllowedTools),
    } : {}) }
  }
  async function update(patch: Partial<FeishuCredential>) {
    const current = await credentials.read()
    if (!current) throw invalid()
    await credentials.write(parseCredential({ ...current, ...patch }))
    return status()
  }
  return {
    read: credentials.read,
    status,
    start: () => state.serialize(() => pairing.start(ownerId)),
    poll: (taskId: string) => state.serialize(() => pairing.poll(ownerId, taskId)),
    setEnabled: (enabled: boolean) => state.serialize(async () => {
      if (!enabled) state.clear()
      const current = await credentials.read()
      if (!current) throw invalid()
      if (current.enabled !== enabled) {
        await credentials.write({ ...current, enabled, revision: randomUUID() })
        await onChanged?.()
      }
      return status()
    }),
    setGroupChat: (enabled: boolean) => state.serialize(() => update({ groupChatEnabled: enabled })),
    setPrivateStreaming: (enabled: boolean) => state.serialize(async () => {
      const current = await credentials.read()
      if (!current) throw invalid()
      if (current.privateStreamingEnabled !== enabled) {
        await credentials.write({ ...current, privateStreamingEnabled: enabled, revision: randomUUID() })
        await onChanged?.()
      }
      return status()
    }),
    setGroupReplyMode: (groupReplyMode: GroupReplyMode) => state.serialize(() => update({ groupReplyMode })),
    setGroupAttentionMode: (groupAttentionMode: GroupAttentionMode) => state.serialize(() => update({ groupAttentionMode })),
    setGroupWebTools: (enabled: boolean) => state.serialize(async () => {
      const current = await credentials.read(); if (!current) throw invalid()
      const tools = new Set(current.groupAllowedTools)
      for (const tool of ['http_get', 'similar_image_search', 'send_file']) enabled ? tools.add(tool) : tools.delete(tool)
      return update({ groupAllowedTools: [...tools] })
    }),
    setGroupProviderSearch: (enabled: boolean) => state.serialize(async () => {
      const current = await credentials.read(); if (!current) throw invalid()
      const tools = new Set(current.groupAllowedTools); enabled ? tools.add('web_search') : tools.delete('web_search')
      return update({ groupAllowedTools: [...tools] })
    }),
    setGroupHistorySearch: (enabled: boolean) => state.serialize(async () => {
      const current = await credentials.read(); if (!current) throw invalid()
      const tools = new Set(current.groupAllowedTools); enabled ? tools.add('group_context_search') : tools.delete('group_context_search')
      return update({ groupAllowedTools: [...tools] })
    }),
    setGroupOwnerMemory: (groupOwnerMemoryEnabled: boolean) => state.serialize(() => update({ groupOwnerMemoryEnabled })),
    setGroupMemory: (groupMemoryEnabled: boolean) => state.serialize(() => update({ groupMemoryEnabled })),
    setMemberMemory: (memberMemoryEnabled: boolean) => state.serialize(() => update({ memberMemoryEnabled })),
    updateGroupSettings: (patch: GroupSettingsPatch) => state.serialize(async () => {
      const current = await credentials.read()
      if (!current) throw invalid()
      const { groupWebToolsEnabled, groupProviderSearchEnabled, groupHistorySearchEnabled, ...settings } = patch
      const groupAllowedTools = updateUserBotGroupTools(current.groupAllowedTools,
        { groupWebToolsEnabled, groupProviderSearchEnabled, groupHistorySearchEnabled })
      return update({ ...settings, groupAllowedTools })
    }),
  }
}
