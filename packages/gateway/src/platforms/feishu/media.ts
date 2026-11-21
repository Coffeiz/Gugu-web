import { createImMediaBudget } from '../../runtime/media-budget.js'
import { imImageFormat, imMediaFilename } from '../../runtime/media-format.js'
import { FeishuApiError, type createFeishuClient } from './client.js'
import { parseFeishuQuoteFacts, type ParsedFeishuMessage } from './message.js'

export class FeishuMediaIngressError extends Error {
  constructor(readonly code: 'feishu_media_download' | 'feishu_media_stage', readonly httpStatus?: number) {
    super('飞书附件处理未完成')
  }

  get notice() {
    return this.code === 'feishu_media_download'
      ? '暂时无法从飞书下载附件，请稍后重新发送。'
      : '飞书附件保存失败，请稍后重新发送。'
  }
}

type FeishuMediaFile = { name: string; ext: string; mime: string; bytes: Uint8Array; voice: boolean }

/** 在同一批次额度内下载飞书附件，并按消息顺序交给宿主暂存。 */
export async function processFeishuMedia(
  items: ParsedFeishuMessage['mediaItems'],
  client: Pick<ReturnType<typeof createFeishuClient>, 'downloadResource'>,
  options: { maxBytes: number; maxFiles?: number; signal: AbortSignal; authorize?: () => Promise<boolean> },
  stage: (file: FeishuMediaFile, index: number) => Promise<void>,
): Promise<void> {
  const { signal, authorize } = options
  const budget = createImMediaBudget(options.maxBytes, options.maxFiles)
  for (const [index, item] of items.entries()) {
    signal.throwIfAborted()
    let bytes: Uint8Array
    try {
      if (!budget.remaining || authorize && !await authorize()) throw new FeishuMediaIngressError('feishu_media_download')
      bytes = await client.downloadResource(item.messageId, item.resourceKey, item.resourceType, { signal, maxBytes: budget.remaining, ...(authorize ? { authorize } : {}) })
    } catch (error) {
      signal.throwIfAborted()
      throw new FeishuMediaIngressError('feishu_media_download', error instanceof FeishuApiError ? error.statusCode : undefined)
    }
    signal.throwIfAborted()
    if (!budget.consume(bytes.byteLength)) throw new FeishuMediaIngressError('feishu_media_download')
    const format = item.resourceType === 'image' ? imImageFormat(bytes) : null
    try {
      await stage({ ...imMediaFilename(item.fileName), mime: 'application/octet-stream', ...(format ?? {}), bytes, voice: item.isVoice }, index)
    } catch {
      signal.throwIfAborted()
      throw new FeishuMediaIngressError('feishu_media_stage')
    }
  }
}

/** 仅返回飞书查询确认属于当前会话的引用事实。 */
export async function readFeishuQuote(
  parsed: ParsedFeishuMessage,
  client: Pick<ReturnType<typeof createFeishuClient>, 'call'>,
  botOpenId: string | null,
  signal: AbortSignal,
  authorize?: () => Promise<boolean>,
) {
  const quote = parsed.quoteRequest
  if (!quote) return null
  signal.throwIfAborted()
  const response = await client.call('GET', `/open-apis/im/v1/messages/${quote.messageId}?card_msg_content_type=${quote.cardContentType}`, {
    signal, ...(authorize ? { authorize } : {}),
  })
  signal.throwIfAborted()
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  const data = object(response.data) ? response.data : response
  const item: unknown = Array.isArray(data.items) ? data.items[0] : null
  if (!object(item) || item.chat_id !== parsed.payload.chat_id || (item.message_id !== undefined && item.message_id !== quote.messageId)) return null
  const facts = parseFeishuQuoteFacts(item, botOpenId)
  return { quoted_text: facts.text, reply_target_sender_id: facts.sender_id, reply_target_is_bot: facts.sender_is_bot }
}
