import { randomUUID } from 'node:crypto'
import { createFeishuPairing } from '@gugu/gateway/feishu'
import { createEncryptedDesktopStore } from '../../../../auth/store.js'
import { DesktopError } from '../../../../core-host.js'
import { createDesktopPairingState } from '../../pending.js'

type Transport = Parameters<typeof createFeishuPairing>[0]['transport']
type Encryption = Parameters<typeof createEncryptedDesktopStore>[2]

function parseCredential(input: unknown) {
  if (!input || typeof input !== 'object') throw invalid()
  const { appId, appSecret, userId, enabled, revision } = input as Record<string, unknown>
  if (typeof appId !== 'string' || !appId || typeof appSecret !== 'string' || !appSecret
    || typeof userId !== 'string' || !userId || typeof enabled !== 'boolean'
    || typeof revision !== 'string' || !revision) throw invalid()
  return { appId, appSecret, userId, enabled, revision }
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
      await credentials.write(parseCredential({ appId, appSecret, userId, enabled: true, revision: randomUUID() }))
      await onChanged?.()
      return { id: 1, name: '我的飞书', app_id: appId }
    },
  })

  async function status() {
    const current = await credentials.read()
    return { configured: Boolean(current), enabled: current?.enabled === true }
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
  }
}
