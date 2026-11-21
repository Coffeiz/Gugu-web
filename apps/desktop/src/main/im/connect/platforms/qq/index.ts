import type { DesktopQqGroupReplyMode } from '@gugu/core/desktop'
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { IM_BINDING_MAX_ATTEMPTS, IM_BINDING_TTL_SECONDS } from '@gugu/core/im/binding-code'
import { createQqPairing } from '@gugu/gateway/qq'
import { createEncryptedDesktopStore } from '../../../../auth/store.js'
import { DesktopError } from '../../../../core-host.js'
import { createDesktopPairingState } from '../../pending.js'

type Transport = Parameters<typeof createQqPairing>[0]['transport']
type Encryption = Parameters<typeof createEncryptedDesktopStore>[2]

interface QqCredential {
  appId: string
  appSecret: string
  enabled: boolean
  revision: string
  userId: string | null
  bindingEventId: string | null
  groupMessageFormat?: 'compat' | 'markdown'
  privateMessageFormat: 'compat' | 'markdown'
  privateStreamingEnabled: boolean
  groupChatEnabled?: boolean
  groupHistorySearchEnabled?: boolean
  groupWebToolsEnabled?: boolean
  groupProviderSearchEnabled?: boolean
  groupOwnerMemoryEnabled?: boolean
  groupMemoryEnabled?: boolean
  memberMemoryEnabled?: boolean
  groupReplyMode?: DesktopQqGroupReplyMode
}

function parseCredential(input: unknown): QqCredential {
  if (!input || typeof input !== 'object') throw invalid()
  const { appId, appSecret, enabled, revision, userId, bindingEventId, groupChatEnabled = false, groupHistorySearchEnabled = false, groupWebToolsEnabled = false, groupProviderSearchEnabled = false, groupOwnerMemoryEnabled = false, groupMemoryEnabled = true, memberMemoryEnabled = true, groupReplyMode = 'reply_mentions', groupMessageFormat = 'compat', privateMessageFormat = 'markdown', privateStreamingEnabled = privateMessageFormat === 'markdown' } = input as Record<string, unknown>
  if (typeof appId !== 'string' || !appId || typeof appSecret !== 'string' || !appSecret
    || (groupMessageFormat !== 'compat' && groupMessageFormat !== 'markdown')
    || (privateMessageFormat !== 'compat' && privateMessageFormat !== 'markdown')
    || typeof privateStreamingEnabled !== 'boolean'
    || (groupReplyMode !== 'reply_mentions' && groupReplyMode !== 'reply_all' && groupReplyMode !== 'record_only')
    || typeof enabled !== 'boolean' || typeof groupChatEnabled !== 'boolean' || typeof groupHistorySearchEnabled !== 'boolean' || typeof groupWebToolsEnabled !== 'boolean' || typeof groupProviderSearchEnabled !== 'boolean'
    || typeof groupOwnerMemoryEnabled !== 'boolean' || typeof groupMemoryEnabled !== 'boolean' || typeof memberMemoryEnabled !== 'boolean'
    || typeof revision !== 'string' || !revision
    || (userId !== null && (typeof userId !== 'string' || !userId))
    || (bindingEventId !== null && (userId === null || typeof bindingEventId !== 'string' || !bindingEventId))) throw invalid()
  return { appId, appSecret, enabled, revision, userId, groupChatEnabled, groupHistorySearchEnabled, groupWebToolsEnabled, groupProviderSearchEnabled, groupOwnerMemoryEnabled, groupMemoryEnabled, memberMemoryEnabled, groupReplyMode, groupMessageFormat, privateMessageFormat, privateStreamingEnabled, bindingEventId: bindingEventId as string | null }
}

function invalid() { return new DesktopError('invalid_request', 'QQ 连接缺少有效凭据') }

export function createDesktopQqPairing(directory: string, encryption: Encryption, ownerId: string,
  transport: Transport, notifyChanged?: () => void) {
  const credentials = createEncryptedDesktopStore(directory, 'im-qq', encryption, parseCredential)
  const state = createDesktopPairingState()
  let binding: { code: string; expires: number; failures: number; revision: string } | undefined
  const pairing = createQqPairing({
    portalBase: 'https://q.qq.com', transport, store: state.store,
    platforms: () => ['qq'], generateKey: () => randomBytes(32).toString('base64'),
    async saveBot(_owner, appId, appSecret, userOpenId) {
      const previous = await credentials.read()
      await credentials.write(parseCredential({ appId, appSecret, enabled: true, revision: randomUUID(), userId: userOpenId ?? null,
        bindingEventId: null, groupMessageFormat: previous?.groupMessageFormat, privateMessageFormat: previous?.privateMessageFormat, privateStreamingEnabled: previous?.privateStreamingEnabled }))
      binding = undefined
      return { id: 1, name: '我的QQ', app_id: appId }
    },
  })

  async function status() {
    const current = await credentials.read()
    return { configured: Boolean(current), enabled: current?.enabled === true, bound: Boolean(current?.userId), ...(current ? { privateMessageFormat: current.privateMessageFormat, groupMessageFormat: current.groupMessageFormat, privateStreamingEnabled: current.privateStreamingEnabled, groupChatEnabled: current.groupChatEnabled === true, groupReplyMode: current.groupReplyMode, groupHistorySearchEnabled: current.groupHistorySearchEnabled === true, groupWebToolsEnabled: current.groupWebToolsEnabled === true, groupProviderSearchEnabled: current.groupProviderSearchEnabled === true, groupOwnerMemoryEnabled: current.groupOwnerMemoryEnabled === true, groupMemoryEnabled: current.groupMemoryEnabled !== false, memberMemoryEnabled: current.memberMemoryEnabled !== false } : {}) }
  }
  return {
    read: credentials.read,
    issueBinding: () => state.serialize(async () => {
      const current = await credentials.read()
      if (!current?.enabled || current.userId) throw invalid()
      const code = String(randomInt(1_000_000)).padStart(6, '0')
      binding = { code, expires: Date.now() + IM_BINDING_TTL_SECONDS * 1_000, failures: 0, revision: current.revision }
      return { code, expires_in: IM_BINDING_TTL_SECONDS }
    }),
    consumeBinding: (source: { appId: string; revision: string; userId: string; eventId: string; chatType: 'c2c' | 'group' }, code: string) =>
      state.serialize(async () => {
        if (source.chatType !== 'c2c' || !source.userId || !source.eventId) return false
        const current = await credentials.read()
        if (!current?.enabled || current.userId || current.appId !== source.appId || current.revision !== source.revision
          || !binding || binding.revision !== source.revision || binding.expires <= Date.now() || binding.failures >= IM_BINDING_MAX_ATTEMPTS) return false
        if (code !== binding.code) {
          binding.failures++
          return false
        }
        await credentials.write({ ...current, userId: source.userId, bindingEventId: source.eventId })
        binding = undefined
        // 长连接读取最新绑定，消费消息的回调无需等待网关重连。
        return true
      }),
    status,
    setGroupMessageFormat: (format: 'compat' | 'markdown') => state.serialize(async () => {
      const current = await credentials.read()
      if (!current || (format !== 'compat' && format !== 'markdown')) throw invalid()
      await credentials.write({ ...current, groupMessageFormat: format })
      return status()
    }),
    setPrivateMessageFormat: (format: 'compat' | 'markdown') => state.serialize(async () => {
      const current = await credentials.read()
      if (!current) throw invalid()
      await credentials.write({ ...current, privateMessageFormat: format, privateStreamingEnabled: format === 'markdown' && current.privateStreamingEnabled })
      return status()
    }),
    setPrivateStreaming: (enabled: boolean) => state.serialize(async () => {
      const current = await credentials.read()
      if (!current || (enabled && current.privateMessageFormat !== 'markdown')) throw invalid()
      await credentials.write({ ...current, privateStreamingEnabled: enabled })
      return status()
    }),
    setGroupChat: (enabled: boolean) => state.serialize(async () => {
      const current = await credentials.read()
      if (!current || (enabled && !current.userId)) throw invalid()
      if (current.groupChatEnabled !== enabled) {
        await credentials.write({ ...current, groupChatEnabled: enabled, revision: randomUUID() })
        notifyChanged?.()
      }
      return status()
    }),
    setGroupReplyMode: (mode: DesktopQqGroupReplyMode) => state.serialize(async () => {
      const current = await credentials.read()
      if (!current?.userId || (mode !== 'reply_mentions' && mode !== 'reply_all' && mode !== 'record_only')) throw invalid()
      await credentials.write({ ...current, groupReplyMode: mode })
      return status()
    }),
    setGroupHistorySearch: (enabled: boolean) => state.serialize(async () => {
      const current = await credentials.read()
      if (!current?.userId) throw invalid()
      await credentials.write({ ...current, groupHistorySearchEnabled: enabled })
      return status()
    }),
    setGroupWebTools: (enabled: boolean) => state.serialize(async () => {
      const current = await credentials.read()
      if (!current?.userId) throw invalid()
      await credentials.write({ ...current, groupWebToolsEnabled: enabled })
      return status()
    }),
    setGroupProviderSearch: (enabled: boolean) => state.serialize(async () => {
      const current = await credentials.read()
      if (!current?.userId) throw invalid()
      await credentials.write({ ...current, groupProviderSearchEnabled: enabled })
      return status()
    }),
    setGroupOwnerMemory: (enabled: boolean) => state.serialize(async () => {
      const current = await credentials.read()
      if (!current?.userId) throw invalid()
      await credentials.write({ ...current, groupOwnerMemoryEnabled: enabled })
      return status()
    }),
    setGroupMemory: (enabled: boolean) => state.serialize(async () => {
      const current = await credentials.read()
      if (!current?.userId) throw invalid()
      await credentials.write({ ...current, groupMemoryEnabled: enabled })
      return status()
    }),
    setMemberMemory: (enabled: boolean) => state.serialize(async () => {
      const current = await credentials.read()
      if (!current?.userId) throw invalid()
      await credentials.write({ ...current, memberMemoryEnabled: enabled })
      return status()
    }),
    unbind: () => state.serialize(async () => {
      const current = await credentials.read()
      if (!current) throw invalid()
      if (current.userId) {
        await credentials.write({ ...current, userId: null, bindingEventId: null, groupChatEnabled: false, groupHistorySearchEnabled: false, groupWebToolsEnabled: false, groupProviderSearchEnabled: false, revision: randomUUID() })
        state.clear()
        binding = undefined
        notifyChanged?.()
      }
      return status()
    }),
    start: () => state.serialize(() => pairing.start(ownerId)),
    async poll(taskId: string) {
      const result = await state.serialize(() => pairing.poll(ownerId, taskId))
      // 扫码结果以凭据提交为准，网关清理可能等待进入同一绑定队列的消息。
      if (result.status === 'success') notifyChanged?.()
      return result
    },
    setEnabled: (enabled: boolean) => state.serialize(async () => {
      if (!enabled) { state.clear(); binding = undefined }
      const current = await credentials.read()
      if (!current) throw invalid()
      if (current.enabled !== enabled) {
        await credentials.write({ ...current, enabled, revision: randomUUID() })
        notifyChanged?.()
      }
      return status()
    }),
  }
}
