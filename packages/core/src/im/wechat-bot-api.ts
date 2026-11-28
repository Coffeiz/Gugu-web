import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import type { JsonObject, ProviderTransport } from '../agent/providers/contracts.js'
import { ProviderError } from '../agent/providers/errors.js'

export const wechatOrigin = 'https://ilinkai.weixin.qq.com'
export const wechatAttachmentLimit = 30 * 1024 * 1024
const cdnOrigin = 'https://novac2c.cdn.weixin.qq.com'
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

function uploadUrl(ticket: Record<string, unknown>, fileKey: string): string | null {
  try {
    const full = typeof ticket.upload_full_url === 'string' ? ticket.upload_full_url.trim() : ''
    const parameter = ticket.upload_param
    const url = full ? new URL(full) : new URL('/c2c/upload', cdnOrigin)
    if (url.origin !== cdnOrigin || url.pathname !== '/c2c/upload' || url.username || url.password || url.hash) return null
    if (!full) {
      if (typeof parameter !== 'string' || !parameter) return null
      url.searchParams.set('encrypted_query_param', parameter)
      url.searchParams.set('filekey', fileKey)
    }
    return full || url.href
  } catch { return null }
}

export function createWechatBotApi(transport: ProviderTransport, options: {
  generateId(): string
  randomUin(): number
}) {
  async function post(path: 'sendmessage' | 'getuploadurl', token: string, body: JsonObject, signal: AbortSignal) {
    if (!/^[\x21-\x7e]+$/u.test(token)) return null
    signal.throwIfAborted()
    const response = await transport.request({
      url: wechatOrigin + '/ilink/bot/' + path, method: 'POST', timeoutMs: 15_000, allowLocal: false,
      headers: { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': btoa(String(options.randomUin())), Authorization: `Bearer ${token}` },
      body: { ...body, base_info: { channel_version: '2.0.1' } },
    }, signal)
    try {
      if (response.status < 200 || response.status >= 300) return null
      let size = 0, raw = ''
      const decoder = new TextDecoder()
      for await (const chunk of response.body) {
        size += chunk.byteLength
        if (size > 64 * 1024) return null
        raw += decoder.decode(chunk, { stream: true })
      }
      const result = JSON.parse(raw + decoder.decode()) as Record<string, unknown> | null
      return result && typeof result === 'object' && !Array.isArray(result)
        && (result.ret == null || result.ret === 0) && (result.errcode == null || result.errcode === 0) ? result : null
    } finally { await response.cancel() }
  }
  async function send(recipient: string, contextToken: string, token: string, item: JsonObject, signal: AbortSignal) {
    return await post('sendmessage', token, { msg: {
      from_user_id: '', to_user_id: recipient, client_id: options.generateId(), message_type: 2,
      message_state: 2, context_token: contextToken, item_list: [item],
    } }, signal) !== null
  }
  async function upload(url: string, ciphertext: Uint8Array, signal: AbortSignal, authorize: () => Promise<string>) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await authorize()
      signal.throwIfAborted()
      try {
        // 只重试同一个地址和同一份已加密的内容。CDN 请求不携带 Bot 凭据。
        const response = await transport.request({ url, method: 'POST', timeoutMs: 30_000, allowLocal: false,
          headers: { 'Content-Type': 'application/octet-stream' }, body: ciphertext }, signal)
        try {
          if (response.status >= 200 && response.status < 300) return response.headers['x-encrypted-param']?.trim() || null
          if (response.status < 500) return null
        } finally { await response.cancel() }
      } catch (error) {
        if (!(error instanceof ProviderError) || !['network', 'timeout'].includes(error.code)) throw error
        signal.throwIfAborted()
      }
    }
    return null
  }
  return {
    sendText(recipient: string, contextToken: string, token: string, text: string, signal: AbortSignal) {
      return send(recipient, contextToken, token, { type: 1, text_item: { text } }, signal)
    },
    async sendAttachment(recipient: string, token: string, file: { bytes: Uint8Array; ext: string; filename: string },
      signal: AbortSignal, authorize: () => Promise<string>): Promise<boolean> {
      if (file.bytes.byteLength > wechatAttachmentLimit) return false
      await authorize()
      signal.throwIfAborted()
      const key = randomBytes(16), fileKey = randomBytes(16).toString('hex'), aesHex = key.toString('hex')
      const cipher = createCipheriv('aes-128-ecb', key, null)
      const ciphertext = Buffer.concat([cipher.update(file.bytes), cipher.final()])
      const image = imageExtensions.has(file.ext)
      const ticket = await post('getuploadurl', token, {
        filekey: fileKey, aeskey: aesHex, media_type: image ? 1 : 3,
        to_user_id: recipient, rawsize: file.bytes.byteLength, rawfilemd5: createHash('md5').update(file.bytes).digest('hex'),
        filesize: ciphertext.byteLength, no_need_thumb: true,
      }, signal)
      const url = ticket && uploadUrl(ticket, fileKey)
      if (!url) return false
      const receipt = await upload(url, ciphertext, signal, authorize)
      if (!receipt) return false
      const media = { encrypt_query_param: receipt, aes_key: Buffer.from(aesHex, 'utf8').toString('base64'), encrypt_type: 1 }
      const item: JsonObject = image
        ? { type: 2, image_item: { media, mid_size: ciphertext.byteLength } }
        : { type: 4, file_item: { media, file_name: file.filename, len: String(file.bytes.byteLength) } }
      // 最终消息存在未知回执的可能，同一轮只尝试发送一次。
      return send(recipient, await authorize(), token, item, signal)
    },
  }
}
