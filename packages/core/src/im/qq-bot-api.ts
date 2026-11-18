import { createHash } from 'node:crypto'
import type { JsonObject, ProviderTransport } from '../agent/providers/contracts.js'

const api = 'https://api.bot.qq.com'
const sandbox = 'https://sandbox.api.sgroup.qq.com'
const uploadTimeout = 300_000
export const qqAttachmentLimit = 30 * 1024 * 1024
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function endpoint(target: { recipient: string; group: boolean; sandbox: boolean }) {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(target.recipient)) throw new Error('QQ 收件人无效')
  return `${target.sandbox ? sandbox : api}/v2/${target.group ? 'groups' : 'users'}/${target.recipient}`
}

function positive(value: unknown): number {
  const decoded = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
  return typeof decoded === 'number' && Number.isSafeInteger(decoded) && decoded > 0 ? decoded : 0
}

function cosUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('QQ 上传地址无效')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('QQ 上传地址无效') }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
    || (url.hostname !== 'myqcloud.com' && !url.hostname.endsWith('.myqcloud.com'))) throw new Error('QQ 上传地址不受信任')
  return value
}

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const accepted = (value: Record<string, unknown> | null) => typeof value?.id === 'string' && value.id.trim().length > 0
type Target = Parameters<typeof endpoint>[0]

/** QQ 主动消息和富媒体分片协议。调用方提供可信目标与跨阶段授权校验。 */
export function createQqBotApi(transport: ProviderTransport) {
  async function post(url: string, body: JsonObject, signal: AbortSignal, token?: string, timeoutMs = 15_000) {
    signal.throwIfAborted()
    const response = await transport.request({ url, method: 'POST', timeoutMs, allowLocal: false,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `QQBot ${token}` } : {}) }, body,
    }, signal)
    try {
      if (response.status < 200 || response.status >= 300) return null
      const decoder = new TextDecoder()
      let text = '', size = 0
      for await (const chunk of response.body) {
        size += chunk.byteLength
        if (size > 64 * 1024) return null
        text += decoder.decode(chunk, { stream: true })
      }
      const value = record(JSON.parse(text + decoder.decode()))
      return value && (value.code == null || value.code === 0) ? value : null
    } finally { await response.cancel() }
  }
  return {
    async token(appId: string, secret: string, signal: AbortSignal): Promise<string | null> {
      const value = (await post(api + '/app/getAppAccessToken', { appId, clientSecret: secret }, signal))?.access_token
      return typeof value === 'string' && /^[\x21-\x7e]+$/u.test(value) ? value : null
    },
    async sendText(target: Target, text: string, token: string, signal: AbortSignal): Promise<boolean> {
      return accepted(await post(endpoint(target) + '/messages', { msg_type: 0, msg_seq: 1, content: text }, signal, token))
    },
    async sendAttachment(target: Target, file: { bytes: Uint8Array; filename: string; ext: string }, token: string,
      callerSignal: AbortSignal, recheck: () => Promise<void>): Promise<boolean> {
      const { bytes, filename } = file
      if (bytes.byteLength === 0 || bytes.byteLength > qqAttachmentLimit) return false
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(uploadTimeout)])
      const path = endpoint(target)
      const image = imageExtensions.has(file.ext)
      async function step(name: string, body: JsonObject) {
        await recheck()
        const response = await post(path + '/' + name, body, signal, token, uploadTimeout)
        if (!response) throw new Error('QQ 附件请求失败')
        return response
      }
      const prepared = await step('upload_prepare', { file_type: image ? 1 : 4, file_name: filename, file_size: bytes.byteLength,
        md5: md5(bytes), sha1: createHash('sha1').update(bytes).digest('hex'), md5_10m: md5(bytes.subarray(0, 10_002_432)) })
      const uploadId = prepared.upload_id
      const blockSize = positive(prepared.block_size)
      const rawParts: unknown = prepared.parts
      if (typeof uploadId !== 'string' || !uploadId || !blockSize || !Array.isArray(rawParts)
        || rawParts.length !== Math.ceil(bytes.byteLength / blockSize)) throw new Error('QQ 分片计划无效')
      const parts = rawParts.map((raw: unknown) => {
        const part = record(raw)
        return { index: part?.index, url: cosUrl(part?.presigned_url) }
      }).sort((left, right) => Number(left.index) - Number(right.index))
      if (parts.some((part, index) => part.index !== index + 1)) throw new Error('QQ 分片序号不连续')
      const concurrency = Math.min(10, positive(record(prepared.upload_config)?.concurrency ?? prepared.concurrency) || 1)
      for (let offset = 0; offset < parts.length; offset += concurrency) {
        const receipts = await Promise.allSettled(parts.slice(offset, offset + concurrency).map(async ({ url }, index) => {
          await recheck()
          const start = (offset + index) * blockSize
          const chunk = bytes.subarray(start, start + blockSize)
          // COS 仅用服务端签名地址，QQ 凭据始终留在固定 Bot API。
          const receipt = await transport.request({ url, method: 'PUT', timeoutMs: uploadTimeout, allowLocal: false,
            headers: {}, body: chunk }, signal)
          try {
            if (receipt.status < 200 || receipt.status >= 300) throw new Error('QQ 分片存储拒绝请求')
          } finally { await receipt.cancel() }
          await step('upload_part_finish', { upload_id: uploadId, part_index: offset + index + 1, block_size: chunk.byteLength, md5: md5(chunk) })
        }))
        if (receipts.some(receipt => receipt.status === 'rejected')) return false
      }
      const { file_info } = await step('files', { upload_id: uploadId })
      if (typeof file_info !== 'string' || !file_info) return false
      return accepted(await step('messages', { msg_type: 7, msg_seq: 1, media: { file_info }, ...(image ? {} : { content: filename }) }))
    },
  }
}
