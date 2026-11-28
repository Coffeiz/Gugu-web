import type { ProviderHttpResponse } from '../../providers/contracts.js'
import { ProviderError } from '../../providers/errors.js'

const extensions = new Map([
  ['image/jpeg', 'jpg'], ['image/jpg', 'jpg'], ['image/png', 'png'],
  ['image/gif', 'gif'], ['image/webp', 'webp'], ['image/bmp', 'bmp'],
])
const byteLimit = 15 * 1024 * 1024
const tooLarge = { error: '图片过大（超过本次读取上限 15MB）' }
const blocked = { error: '这个链接发不了：地址不符合安全出站策略' }
const redirects = new Set([301, 302, 303, 307, 308])

type OpenImage = (url: string, signal: AbortSignal) => Promise<ProviderHttpResponse>
export type RemoteSendFileImage = { bytes: Uint8Array; ext: string; mime: string }

function publicHttpUrl(value: string, base?: URL): URL {
  let url: URL
  try { url = new URL(value, base) }
  catch { throw new ProviderError('input_rejected') }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password)
    throw new ProviderError('input_rejected')
  return url
}

/** 下载和每一跳重定向都经过同一个出站端口，读取量受声明长度和实际字节数双重限制。 */
export async function downloadSendFileImage(value: string, open: OpenImage, signal: AbortSignal):
  Promise<RemoteSendFileImage | { error: string }> {
  try {
    let url = publicHttpUrl(value)
    for (let hop = 0; ; hop++) {
      signal.throwIfAborted()
      const response = await open(url.href, signal)
      try {
        const location = response.headers.location
        if (redirects.has(response.status) && location && hop < 3) {
          url = publicHttpUrl(location, url)
          continue
        }
        if (response.status !== 200) return { error: `图片下载失败（HTTP ${response.status}）` }

        const [mediaType = ''] = (response.headers['content-type'] ?? '').split(';', 1)
        const mime = mediaType.trim().toLowerCase()
        const ext = extensions.get(mime)
        if (!ext) return { error: '这个链接返回的不是支持的图片格式' }
        const length = response.headers['content-length']
        if (length && /^\d+$/u.test(length) && Number(length) > byteLimit) return tooLarge

        const chunks: Uint8Array[] = []
        let size = 0
        for await (const chunk of response.body) {
          signal.throwIfAborted()
          if (!chunk.byteLength) continue
          size += chunk.byteLength
          if (size > byteLimit) return tooLarge
          chunks.push(chunk)
        }
        if (!size) return { error: '下载到的内容是空的' }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        return { bytes, ext, mime }
      } finally { await response.cancel() }
    }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof ProviderError && error.code === 'input_rejected') return blocked
    return { error: '图片下载失败，换一张或换个来源试试' }
  }
}
