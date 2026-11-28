import type { JsonObject, ProviderTransport } from '../agent/providers/contracts.js'

const base = 'https://open.feishu.cn/open-apis'
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
const fileTypes: Record<string, string> = { pdf: 'pdf', doc: 'doc', docx: 'doc', xls: 'xls', xlsx: 'xls', ppt: 'ppt', pptx: 'ppt', ogg: 'opus', opus: 'opus', mp4: 'mp4' }

export function feishuAttachmentLimit(ext: string): number {
  return (imageExtensions.has(ext) ? 10 : 30) * 1024 * 1024
}

class FeishuRejected extends Error {}

export function isFeishuMessageId(value: string): boolean {
  return /^om_[\w-]{1,160}$/u.test(value)
}

/** 固定飞书端点和响应预算。可信 Host 提供凭据、授权与传输。 */
export function createFeishuBotApi(transport: ProviderTransport) {
  async function post(path: string, body: JsonObject | Uint8Array, signal: AbortSignal, token?: string,
    contentType = 'application/json; charset=utf-8') {
    signal.throwIfAborted()
    const response = await transport.request({
      url: base + path, method: 'POST', timeoutMs: 10_000, allowLocal: false,
      headers: { 'Content-Type': contentType, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body,
    }, signal)
    try {
      if (response.status >= 400 && response.status < 500 && response.status !== 408) throw new FeishuRejected('飞书拒绝请求')
      if (response.status < 200 || response.status >= 300) throw new Error('飞书响应状态异常')
      let size = 0, raw = ''
      const decoder = new TextDecoder()
      for await (const chunk of response.body) {
        signal.throwIfAborted()
        size += chunk.byteLength
        if (size > 64 * 1024) throw new Error('飞书响应超限')
        raw += decoder.decode(chunk, { stream: true })
      }
      const value = JSON.parse(raw + decoder.decode()) as Record<string, unknown> | null
      if (!value || !Number.isInteger(value.code)) throw new Error('飞书响应无效')
      if (value.code !== 0) throw new FeishuRejected('飞书拒绝请求')
      return value
    } finally {
      await Promise.resolve().then(() => response.cancel()).catch(() => undefined)
    }
  }
  return {
    async tenantToken(appId: string, secret: string, signal: AbortSignal): Promise<string> {
      const { tenant_access_token: token } = await post('/auth/v3/tenant_access_token/internal', { app_id: appId, app_secret: secret }, signal)
      if (typeof token !== 'string' || !/^[\x21-\x7e]+$/u.test(token)) throw new Error('飞书访问凭据不可用')
      return token
    },
    async sendText(recipientType: 'chat_id' | 'open_id', recipient: string, text: string, token: string, signal: AbortSignal) {
      await post(`/im/v1/messages?receive_id_type=${recipientType}`, {
        receive_id: recipient, msg_type: 'text', content: JSON.stringify({ text }),
      }, signal, token)
    },
    async sendAttachment(recipientType: 'chat_id' | 'open_id', recipient: string,
      file: { bytes: Uint8Array; ext: string; filename: string }, token: string, signal: AbortSignal, beforePublish: () => Promise<void>) {
      signal.throwIfAborted()
      if (file.bytes.byteLength > feishuAttachmentLimit(file.ext)) throw new FeishuRejected('飞书附件超过上限')
      const image = imageExtensions.has(file.ext)
      const form = new FormData()
      const blob = new Blob([Uint8Array.from(file.bytes)], { type: 'application/octet-stream' })
      if (image) {
        form.append('image_type', 'message')
        form.append('image', blob, file.filename)
      } else {
        form.append('file_type', Object.hasOwn(fileTypes, file.ext) ? fileTypes[file.ext]! : 'stream')
        form.append('file_name', file.filename)
        form.append('file', blob, file.filename)
      }
      const encoded = new Response(form)
      const contentType = encoded.headers.get('content-type')
      if (!contentType) throw new Error('飞书附件请求无效')
      const { data } = await post(image ? '/im/v1/images' : '/im/v1/files',
        new Uint8Array(await encoded.arrayBuffer()), signal, token, contentType)
      const keyField = image ? 'image_key' : 'file_key'
      const mediaKey = (data as Record<string, unknown> | null)?.[keyField]
      if (typeof mediaKey !== 'string' || !mediaKey) throw new Error('飞书附件上传回执无效')
      await beforePublish()
      await post(`/im/v1/messages?receive_id_type=${recipientType}`, { receive_id: recipient,
        msg_type: image ? 'image' : 'file', content: JSON.stringify({ [keyField]: mediaKey }) }, signal, token)
    },
    async react(messageId: string, emoji: string, token: string, signal: AbortSignal) {
      if (!isFeishuMessageId(messageId)) return 'rejected' as const
      signal.throwIfAborted()
      try {
        await post(`/im/v1/messages/${messageId}/reactions`, { reaction_type: { emoji_type: emoji } }, signal, token)
        return 'sent' as const
      } catch (error) {
        return error instanceof FeishuRejected ? 'rejected' as const : 'unknown' as const
      }
    },
  }
}
