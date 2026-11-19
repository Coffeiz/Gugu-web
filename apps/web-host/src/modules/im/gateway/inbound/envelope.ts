import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import type { NodeImBotBinding } from './inbox.js'

type Payload = Record<string, unknown>
const object = (value: unknown): value is Payload => !!value && typeof value === 'object' && !Array.isArray(value)
const fields = ['platform', 'owner_user_id', 'bot_id', 'channel_id', 'chat_type', 'chat_id', 'platform_user_id', 'message_id'] as const
const prefix = 'im1:'
const admittedPrefix = 'im2:'
const limit = 1_048_576
function invalid(): never { throw new Error('IM 入站密封载荷无效') }
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return invalid()
  return value
}

/** 所有正文、媒体材料及回复凭证都加密；外层只保留消费者路由/去重必需字段。 */
export function createImInboundEnvelope(secretKey: string) {
  if (!secretKey) throw new TypeError('IM 入站密封密钥未配置')
  const derive = (purpose: string) => Buffer.from(hkdfSync('sha256', Buffer.from(secretKey), Buffer.alloc(0), Buffer.from(`gugu-im-inbound-v1:${purpose}`), 32))
  const encryptionKey = derive('payload'), identityKey = derive('identity')
  const admittedKey = derive('gateway-admitted-payload')
  function bindingFields(binding: NodeImBotBinding, payload: Payload) {
    if (!['feishu', 'qq', 'wechat', 'telegram'].includes(binding.platform) || !/^[1-9]\d*$/.test(binding.botId) || !binding.ownerId) return invalid()
    if (payload.platform !== binding.platform || payload.owner_user_id !== binding.ownerId
      || payload.bot_id !== binding.botId || payload.channel_id !== binding.botId) return invalid()
    if (payload.chat_type !== 'c2c' && payload.chat_type !== 'group') return invalid()
    return { platform: binding.platform, owner_user_id: binding.ownerId, bot_id: binding.botId, channel_id: binding.botId,
      chat_type: payload.chat_type, chat_id: payload.chat_type === 'group' ? identifier(payload.chat_id) : '',
      platform_user_id: identifier(payload.platform_user_id) }
  }
  function plainHeader(binding: NodeImBotBinding, payload: Payload) {
    const route = bindingFields(binding, payload)
    const eventId = identifier(payload._pending_ask_resume_id || payload.message_id)
    return { ...route, message_id: createHmac('sha256', identityKey).update(JSON.stringify([route, eventId])).digest('hex') }
  }
  function aad(header: Payload): Buffer { return Buffer.from(JSON.stringify(fields.map(field => header[field]))) }
  function seal(binding: NodeImBotBinding, input: Payload, admitted: boolean): Payload {
    try {
      const serialized = JSON.stringify(input)
      if (Buffer.byteLength(serialized) > limit) return invalid()
      const value: unknown = JSON.parse(serialized)
      if (!object(value) || Object.hasOwn(value, '__sealed_im')) return invalid()
      const header = plainHeader(binding, value), nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', admitted ? admittedKey : encryptionKey, nonce)
      cipher.setAAD(admitted ? Buffer.concat([Buffer.from('gateway-admitted-v1\0'), aad(header)]) : aad(header))
      const encrypted = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()])
      return { ...header, __sealed_im: (admitted ? admittedPrefix : prefix) + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64') }
    } catch { return invalid() }
  }
  function openForWorker(binding: NodeImBotBinding, envelope: Payload): { payload: Payload; admission: 'raw' | 'gateway' } {
    try {
      const route = bindingFields(binding, envelope), id = identifier(envelope.message_id), encoded = envelope.__sealed_im
      if (!/^[a-f0-9]{64}$/.test(id) || typeof encoded !== 'string' || ![prefix, admittedPrefix].some(value => encoded.startsWith(value))
        || encoded.length > 2 * limit || Object.keys(envelope).some(key => !fields.includes(key as typeof fields[number]) && key !== '__sealed_im')) return invalid()
      const admitted = encoded.startsWith(admittedPrefix), raw = encoded.slice(prefix.length), bytes = Buffer.from(raw, 'base64')
      if (bytes.length < 28 || bytes.toString('base64') !== raw) return invalid()
      const cipher = createDecipheriv('aes-256-gcm', admitted ? admittedKey : encryptionKey, bytes.subarray(0, 12))
      const header = aad({ ...route, message_id: id })
      cipher.setAAD(admitted ? Buffer.concat([Buffer.from('gateway-admitted-v1\0'), header]) : header)
      cipher.setAuthTag(bytes.subarray(12, 28))
      const plaintext = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()])
      if (plaintext.byteLength > limit) return invalid()
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
      if (!object(value) || Object.hasOwn(value, '__sealed_im') || !aad(plainHeader(binding, value)).equals(aad(envelope))) return invalid()
      return { payload: value, admission: admitted ? 'gateway' : 'raw' }
    } catch { return invalid() }
  }
  return {
    seal: (binding: NodeImBotBinding, input: Payload) => seal(binding, input, false),
    /** 仅由完成正式控制分流的Gateway调用；独立密钥/AAD绑定完整scope与原生事件身份。 */
    sealAdmitted: (binding: NodeImBotBinding, input: Payload) => seal(binding, input, true),
    open: (binding: NodeImBotBinding, envelope: Payload) => openForWorker(binding, envelope).payload,
    openForWorker,
  }
}
