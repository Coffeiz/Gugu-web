import { randomInt, randomUUID } from 'node:crypto'
import { createWechatPairing } from '@gugu/gateway/wechat'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import { createEncryptedDesktopStore } from '../../../../auth/store.js'
import { createDesktopPairingState } from '../../pending.js'
import { DesktopError } from '../../../../core-host.js'

type Encryption = Parameters<typeof createEncryptedDesktopStore>[2]
type Options = Parameters<typeof createWechatPairing>[0]
const portalBase = 'https://ilinkai.weixin.qq.com'

function parseCredential(value: unknown): { token: string; baseUrl: string; revision: string; enabled: boolean; botId: string; userId: string } {
  if (!value || typeof value !== 'object' || !('token' in value) || typeof value.token !== 'string'
    || !value.token || /[\r\n]/.test(value.token) || !('baseUrl' in value) || typeof value.baseUrl !== 'string'
    || !('revision' in value) || typeof value.revision !== 'string'
    || !('enabled' in value) || typeof value.enabled !== 'boolean'
    || !('botId' in value) || typeof value.botId !== 'string' || !value.botId
    || !('userId' in value) || typeof value.userId !== 'string' || !value.userId)
    throw new DesktopError('invalid_request', '微信连接凭据无效')
  const url = new URL(value.baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.href !== url.origin + '/')
    throw new DesktopError('invalid_request', '微信连接地址无效')
  return { token: value.token, baseUrl: url.origin, revision: value.revision,
    enabled: value.enabled, botId: value.botId, userId: value.userId }
}

export function createDesktopWechatPairing(directory: string, encryption: Encryption, ownerId: string,
  transport: Options['transport'] = createNodeProviderTransport(), onSaved?: () => void | Promise<void>) {
  const credentials = createEncryptedDesktopStore(directory, 'im-wechat', encryption, parseCredential)
  const state = createDesktopPairingState()
  const pairing = createWechatPairing({
    portalBase, transport, platforms: () => ['wechat'],
    generateId: () => randomUUID().replaceAll('-', ''), randomUin: () => randomInt(0xffffffff),
    store: state.store,
    async saveBot(_owner, token, base, { botId, userId }) {
      if (typeof botId !== 'string' || !botId || typeof userId !== 'string' || !userId)
        throw new DesktopError('invalid_request', '微信扫码未返回绑定身份，请重试')
      const next = parseCredential({ token, baseUrl: base || portalBase, revision: randomUUID(), enabled: true, botId, userId })
      await credentials.write(next)
      await onSaved?.()
      return { id: 1, name: '我的微信' }
    },
  })
  async function status() {
    const current = await credentials.read()
    const configured = Boolean(current)
    return { configured, enabled: configured && current?.enabled === true, ...(current ? { detail: current.baseUrl } : {}) }
  }
  return {
    status,
    setEnabled: (enabled: boolean) => state.serialize(async () => {
      if (!enabled) state.clear()
      const current = await credentials.read()
      if (!current) throw new DesktopError('invalid_request', '请先扫码绑定微信')
      if (enabled !== current.enabled) {
        await credentials.write({ ...current, enabled, revision: randomUUID() })
        await onSaved?.()
      }
      return status()
    }),
    start: () => state.serialize(() => pairing.start(ownerId)),
    poll: (id: string) => state.serialize(() => pairing.poll(ownerId, id)),
    read: credentials.read,
  }
}
