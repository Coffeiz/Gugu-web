/** 消息发送时认领的附件元数据；存储位置和用户身份仅由 Host 持有。 */
export interface CurrentTurnAttachment {
  readonly attach_id: string
  readonly name: string
  readonly ext: string
  readonly mime: string | null
  readonly size: number | string
  readonly kind: string
  readonly qq_face?: boolean | null
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
    if (attachment.kind !== 'text') continue
    const tag = `《${currentTurnAttachmentName(attachment)}》(attach_id=${attachment.attach_id})`
    if (size > CHAT_ATTACHMENT_TEXT_READ_MAX) {
      parts.push(`\n\n📎 用户上传的文件${tag}（正文过大，超过 32MB，未直接读取；可保存到文件库——用户要存就 save_uploaded_file(attach_id)——后续按需处理；read_file 对 PDF/Office 的提取上限更小，不要反复尝试读取全文）。`)
      continue
    }
    let content = ''
    try { content = await readText(attachment) } catch { /* Python read_text 对解析/存储失败返回空串。 */ }
    if (typeof content !== 'string') content = ''
    parts.push(`\n\n📎 用户上传的文件${tag}，内容如下：\n\`\`\`\n${content.slice(0, CHAT_ATTACHMENT_TEXT_INJECT_MAX)}\n\`\`\``)
  }
  return { rawText: parts.join(''), cards }
}
