import { createHash } from 'node:crypto'
import type { Block, HistoryIdentity, RunIdentity } from '../models.js'
import type { ContextReferenceCodec } from '../ports.js'

/** 消息发送时认领的附件元数据；存储位置和用户身份仅由 Host 持有。 */
export interface CurrentTurnAttachment {
  readonly attach_id: string
  readonly name: string
  readonly ext: string
  readonly mime: string | null
  readonly size: number | string
  readonly kind: string
  readonly qq_face?: boolean | null
  readonly transcript?: string
  readonly quoted?: boolean | null
  readonly duration?: number | null
  readonly img_width?: number | null
  readonly img_height?: number | null
}

export interface CurrentTurnAttachmentCard extends Record<string, unknown> {
  attach_id: string
  name: string
  ext: string
  size_bytes: number
  kind: string
  upload: true
}

export const CHAT_ATTACHMENT_TEXT_READ_MAX = 32 * 1024 * 1024
export const CHAT_ATTACHMENT_TEXT_INJECT_MAX = 32_000

/** 隐藏 IM 下载器生成的随机文件名，保留用户给的可识别名称。 */
export function currentTurnAttachmentName(attachment: Pick<CurrentTurnAttachment, 'name' | 'ext' | 'kind' | 'qq_face'>): string {
  if (attachment.qq_face) return 'QQ表情'
  const name = attachment.name || '附件'
  if (/^[\da-f]{24,}$/i.test(name)) {
    return ({ image: '图片', audio: '音频', video: '视频', voice: '语音', text: '文本文件' } as Record<string, string>)[attachment.kind] ?? '文件'
  }
  return attachment.ext ? `${name}.${attachment.ext.toLowerCase()}` : name
}

function metadataSize(attachment: CurrentTurnAttachment): number {
  const size = typeof attachment.size === 'number' ? attachment.size : Number(attachment.size)
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('聊天附件元数据无效')
  return size
}

function cardFor(attachment: CurrentTurnAttachment, size: number): CurrentTurnAttachmentCard {
  return {
    attach_id: attachment.attach_id, name: attachment.name, ext: attachment.ext,
    size_bytes: size, kind: attachment.kind, upload: true, mime: attachment.mime,
    qq_face: Boolean(attachment.qq_face), quoted: Boolean(attachment.quoted),
    duration: attachment.duration ?? null, img_width: attachment.img_width ?? null,
    img_height: attachment.img_height ?? null,
  }
}

/**
 * 将已按 owner+message 读取的附件元数据投影为 Python Web Chat 的当前轮次文本。
 * 32 MiB 的源文件门必须先于 readText（Host 的物理字节读取）；失败按旧 read_text
 * 语义注入空内容，同时仍保留聊天卡片。非文本附件只保留卡片，交给媒体切片处理。
 */
export async function resolveCurrentTurnTextAttachments(
  baseText: string,
  attachments: readonly CurrentTurnAttachment[],
  readText: (attachment: CurrentTurnAttachment) => Promise<string>,
): Promise<{ rawText: string; cards: CurrentTurnAttachmentCard[] }> {
  if (typeof baseText !== 'string' || typeof readText !== 'function') throw new TypeError('当前消息附件服务无效')
  const parts = baseText ? [baseText] : []
  const cards: CurrentTurnAttachmentCard[] = []
  for (const attachment of attachments) {
    if (!attachment || typeof attachment.attach_id !== 'string' || !attachment.attach_id
      || typeof attachment.name !== 'string' || typeof attachment.ext !== 'string'
      || typeof attachment.kind !== 'string' || (attachment.mime !== null && typeof attachment.mime !== 'string')) {
      throw new TypeError('聊天附件元数据无效')
    }
    const size = metadataSize(attachment)
    cards.push(cardFor(attachment, size))
    if (attachment.kind === 'voice' && typeof attachment.transcript === 'string' && attachment.transcript.trim()) {
      const transcript = attachment.transcript.trim()
      cards[cards.length - 1]!.transcript = transcript
      parts.push(`${parts.length ? "\n\n" : ""}语音转写：${transcript}`)
      continue
    }
    if (attachment.kind !== 'text') continue
    const tag = `《${currentTurnAttachmentName(attachment)}》(attach_id=${attachment.attach_id})`
    if (size > CHAT_ATTACHMENT_TEXT_READ_MAX) {
      parts.push(`\n\n📎 用户上传的文件${tag}（正文过大，超过 32MB，未直接读取；可保存到文件库——用户要存就 save_attachment(attach_id)）。`)
      continue
    }
    let content = ''
    try { content = await readText(attachment) } catch { /* Python read_text 对解析/存储失败返回空串。 */ }
    if (typeof content !== 'string') content = ''
    parts.push(`\n\n📎 用户上传的文件${tag}，内容如下：\n\`\`\`\n${content.slice(0, CHAT_ATTACHMENT_TEXT_INJECT_MAX)}\n\`\`\``)
  }
  return { rawText: parts.join(''), cards }
}

export interface CurrentTurnImagePort {
  maxInputBytes: number
  readImage(attachment: CurrentTurnAttachment, signal: AbortSignal): Promise<{ bytes: Uint8Array; mime: string } | null>
}

function imageBlock(image: { bytes: Uint8Array; mime: string }): Block {
  return { type: 'image', source: {
    type: 'base64', media_type: image.mime, data: Buffer.from(image.bytes).toString('base64'),
  } }
}

/** 图片序号按本轮实际发给模型的图片块计算。 */
export function formatQuotedImageNotice(imageCount: number, quotedPositions: readonly number[]) {
  return quotedPositions.length
    ? `随消息提供了 ${imageCount} 张图片，其中第 ${quotedPositions.join('、')} 张来自引用消息。`
    : ''
}

/** 仅构建本轮 Provider 输入，附件卡片及落库正文不包含图片字节。 */
export async function resolveCurrentTurnImages(
  attachments: readonly CurrentTurnAttachment[],
  port?: CurrentTurnImagePort,
  signal = new AbortController().signal,
): Promise<{ blocks: Block[]; notice: string }> {
  const images = attachments.filter(file => file.kind === 'image' && /^[0-9a-f]{32}$/u.test(file.attach_id))
  const blocks: Block[] = []
  const deferred: string[] = []
  const quotedPositions: number[] = []
  const deferredQuotes: string[] = []
  for (const file of images) {
    signal.throwIfAborted()
    const size = metadataSize(file)
    if (port && blocks.length < 6 && size > 0 && size <= port.maxInputBytes) {
      let image: Awaited<ReturnType<CurrentTurnImagePort['readImage']>> = null
      try { image = await port.readImage(file, signal) } catch { signal.throwIfAborted() }
      signal.throwIfAborted()
      if (image?.bytes.byteLength) {
        blocks.push(imageBlock(image))
        if (file.quoted) quotedPositions.push(blocks.length)
        continue
      }
    }
    const pending = file.quoted ? deferredQuotes : deferred
    pending.push(file.attach_id)
  }
  const notice = [
    formatQuotedImageNotice(blocks.length, quotedPositions) || (blocks.length ? `用户上传了 ${blocks.length} 张图片。` : ''),
    deferredQuotes.length ? `引用消息中的图片可用 view_image 查看（attach_id：${deferredQuotes.join('、')}）。` : '',
    deferred.length ? `用户上传了图片，可用 view_image 查看（attach_id：${deferred.join('、')}）。` : '',
  ].filter(Boolean).join('\n\n')
  return { blocks, notice }
}

/** 当前轮图片以附件 ID 固化，重建请求时由 Host 再次校验归属和模型能力。 */
export function createCurrentTurnImageReferences(
  read: (identity: RunIdentity, id: string, signal: AbortSignal, expectedSize?: number) => ReturnType<CurrentTurnImagePort['readImage']>,
) {
  const ids = new Map<string, Set<string>>()
  const key = (identity: HistoryIdentity, data: string, mime: string) =>
    JSON.stringify([identity.ownerId, identity.sessionId, 'runId' in identity ? identity.runId : null,
      mime, createHash('sha256').update(data).digest('hex')])

  async function readImage(identity: RunIdentity, id: string, signal: AbortSignal, expectedSize?: number) {
    const image = await read(identity, id, signal, expectedSize)
    if (image?.bytes.byteLength) {
      const fingerprint = key(identity, Buffer.from(image.bytes).toString('base64'), image.mime)
      const matches = ids.get(fingerprint) ?? new Set<string>()
      matches.add(id)
      ids.set(fingerprint, matches)
    }
    return image
  }

  function runIdentity(identity: HistoryIdentity): identity is RunIdentity {
    return 'runId' in identity && typeof identity.runId === 'string'
  }

  const codec: ContextReferenceCodec = {
    async dehydrate({ message }, identity) {
      if (!runIdentity(identity) || message.role !== 'user' || !Array.isArray(message.content)) return message
      const occurrences = new Map<string, number>()
      return { ...message, content: message.content.map(block => {
        if (!block || typeof block !== 'object' || Array.isArray(block) || block.type !== 'image') return block
        const source = block.source
        if (!source || typeof source !== 'object' || Array.isArray(source) || source.type !== 'base64'
          || typeof source.data !== 'string' || typeof source.media_type !== 'string') return block
        const fingerprint = key(identity, source.data, source.media_type)
        const index = occurrences.get(fingerprint) ?? 0
        occurrences.set(fingerprint, index + 1)
        const id = [...(ids.get(fingerprint) ?? [])][index]
        return id ? { type: 'attachment_ref', kind: 'image', attach_id: id } : block
      }) }
    },
    async hydrate({ message }, identity, signal = new AbortController().signal) {
      if (!runIdentity(identity) || message.role !== 'user' || !Array.isArray(message.content)) return message
      const content = []
      for (const block of message.content) {
        if (block && typeof block === 'object' && !Array.isArray(block) && block.type === 'attachment_ref'
          && block.kind === 'image' && typeof block.attach_id === 'string') {
          const image = await readImage(identity, block.attach_id, signal)
          content.push(image ? imageBlock(image) : { type: 'text', text: `图片未能重新载入，可用 view_image 查看（attach_id：${block.attach_id}）。` })
        } else content.push(block)
      }
      return { ...message, content }
    },
  }
  return { readImage, codec }
}
