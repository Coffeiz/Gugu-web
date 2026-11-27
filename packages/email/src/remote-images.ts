import { imageSize } from 'image-size'
import { get } from 'node:https'
import { isIP } from 'node:net'

const maxImageBytes = 5 * 1024 * 1024
const maxImages = 64
export const mailImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])

export type MailImageRequest = (url: URL, signal: AbortSignal) => Promise<{
  status: number; headers: Readonly<Record<string, string>>; body: AsyncIterable<Uint8Array>; cancel(): void | Promise<void>
}>

export type MailImageResize = (bytes: Buffer, mime: string, width: number, height: number) => Buffer | undefined

function encodeRaster(bytes: Buffer, declared: string, resize?: MailImageResize) {
  if (declared !== 'application/octet-stream' && !mailImageTypes.has(declared)) return undefined
  let mime = declared
  if (resize || declared === 'application/octet-stream') {
    const { type, width, height } = imageSize(bytes)
    mime = type === 'jpg' ? 'image/jpeg' : `image/${type}`
    if (!mailImageTypes.has(mime) || !width || !height || width * height > 24_000_000) return undefined
    if (resize && bytes.length > 256_000 && ['image/jpeg', 'image/png'].includes(mime))
      bytes = resize(bytes, mime, width, height) ?? bytes
  }
  return `data:${mime};base64,${bytes.toString('base64')}`
}

const imageAccept = 'image/png,image/jpeg,image/gif,image/webp,image/avif'

function decodeAttribute(value: string) {
  const entities: Record<string, string> = { amp: '&', quot: '"', lt: '<', gt: '>', '#x27': "'" }
  return value.replace(/&(amp|quot|lt|gt|#x27);/g, (_, entity: string) => entities[entity]!)
}

async function fetchImage(value: string, resolveAddress: (host: string, port: number) => Promise<string>, signal: AbortSignal, redirects = 0, requestImage?: MailImageRequest, resize?: MailImageResize): Promise<string | undefined> {
  const url = new URL(redirects ? value : decodeAttribute(value))
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined
  if (requestImage) {
    const response = await requestImage(url, signal)
    let consumed = false
    try {
      const location = response.headers.location
      if (redirects < 2 && location && [301, 302, 303, 307, 308].includes(response.status))
        return fetchImage(new URL(location, url).href, resolveAddress, signal, redirects + 1, requestImage, resize)
      const mime = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? ''
      if (response.status !== 200 || !(mailImageTypes.has(mime) || mime === 'application/octet-stream')) return undefined
      const chunks: Uint8Array[] = []
      let length = 0
      for await (const chunk of response.body) {
        length += chunk.byteLength
        if (length > maxImageBytes) return undefined
        chunks.push(chunk)
      }
      consumed = true
      return encodeRaster(Buffer.concat(chunks), mime, resize)
    } finally { if (!consumed) await response.cancel() }
  }
  const address = await resolveAddress(url.hostname, 443)
  const family = isIP(address)
  if (!family) return undefined
  return await new Promise<string | undefined>((resolve, reject) => {
    const request = get(url, {
      agent: false, signal, ...{ family, autoSelectFamily: false },
      lookup: (_host, _options, callback) => callback(null, address, family),
      headers: { Accept: imageAccept },
    }, response => {
      const location = response.headers.location
      if (redirects < 2 && location && [301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        response.destroy()
        try { resolve(fetchImage(new URL(location, url).href, resolveAddress, signal, redirects + 1, undefined, resize)) }
        catch { resolve(undefined) }
        return
      }
      const mime = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? ''
      if (response.statusCode !== 200 || !(mailImageTypes.has(mime) || mime === 'application/octet-stream')) {
        response.destroy()
        resolve(undefined)
        return
      }
      let length = 0
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > maxImageBytes) {
          resolve(undefined)
          response.destroy()
        } else chunks.push(chunk)
      })
      response.once('end', () => {
        try { resolve(encodeRaster(Buffer.concat(chunks), mime, resize)) } catch { resolve(undefined) }
      })
      response.once('error', reject)
      response.once('aborted', () => resolve(undefined))
    })
    request.once('error', reject)
  })
}

/** 只读取已授权邮件正文中清理器标记的图片，返回可在隔离阅读器内显示的数据。 */
export async function loadRemoteMailImages(html: string, resolveAddress: (host: string, port: number) => Promise<string>, requestImage?: MailImageRequest, resize?: MailImageResize) {
  const occurrences = new Map<string, number>()
  for (const [, source] of html.matchAll(/\sdata-mail-(?:image|background)="([^"]+)"/gi))
    occurrences.set(source!, (occurrences.get(source!) ?? 0) + 1)
  const sources = [...occurrences.keys()]
  const data = new Map<string, string>()
  const signal = AbortSignal.timeout(20_000)
  const encodedBytes = [...html.matchAll(/data:image\/[^;]+;base64,[a-z0-9+/=]+/gi)]
    .reduce((size, match) => size + match[0].length, 0)
  let remainingBytes = 12_000_000 - encodedBytes
  const pending = sources.slice(0, maxImages)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
    while (next < pending.length && remainingBytes > 0 && !signal.aborted) {
      const source = pending[next++]!
      const encoded = await fetchImage(source, resolveAddress, signal, 0, requestImage, resize).catch(() => undefined)
      const size = (encoded?.length ?? 0) * (occurrences.get(source) ?? 1)
      if (encoded && size <= remainingBytes) {
        data.set(source, encoded)
        remainingBytes -= size
      }
    }
  }))
  return {
    html: html.replace(/<([a-z][\w-]*)\b([^<>]*)>/gi, (tag, name: string, attrs: string) => {
      const image = / data-mail-image="([^"]+)"/.exec(attrs)
      if (name === 'img' && image && data.has(image[1]!))
        return `<img${attrs.replace(image[0], ` src="${data.get(image[1]!)}"`)}>`
      const background = / data-mail-background="([^"]+)"/.exec(attrs)
      if (!background || !data.has(background[1]!)) return tag
      const rule = `background-image:url(${data.get(background[1]!)})`
      const clean = attrs.replace(background[0], '')
      return `<${name}${/ style="/.test(clean) ? clean.replace(/ style="([^"]*)"/, (_, style: string) => ` style="${style};${rule}"`)
        : `${clean} style="${rule}"`}>`
    }),
    unavailableImages: sources.length - data.size,
  }
}
