import { rollbackImMedia } from '@gugu/gateway'
import { createTelegramBotApi, processTelegramAttachments, telegramAttachmentReference, TelegramMediaIngressError } from '@gugu/gateway/telegram'

const downloadNotice = '有附件暂时无法从 Telegram 下载，请稍后重试或重新发送。'
type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)

export interface TelegramStagedAttachment {
  ownerId: string
  attachId: string
  /** 仅本次新创建的附件能清理，复用附件必须为false。 */
  created: boolean
  creationReceipt?: string
}
export interface TelegramMediaStageInput {
  ownerId: string
  botId: string
  name: string
  ext: string
  mime: string
  data: Uint8Array
  kind: 'image' | 'voice' | 'file'
  duration: number | null
  platform: 'telegram'
  platformMessageId: string | null
  attachmentIndex: number
}
export interface TelegramMediaStorage {
  /** 必须复核owner、Bot和来源消息，引用永远不从平台重新下载。 */
  reuse(input: { ownerId: string; botId: string; platform: 'telegram'; platformMessageId: string; attachmentIndex: number; quoted: true }, signal?: AbortSignal): Promise<{ ownerId: string; attachId: string; created?: boolean; creationReceipt?: string } | null>
  /** 必须落到真实owner暂存；voice由Host复用既有转换/语音链路，不假造ASR。失败须原子回滚。 */
  stage(input: TelegramMediaStageInput, signal?: AbortSignal): Promise<TelegramStagedAttachment>
  /** 只接受stage签发的本次创建收据；不能按任意附件ID或目录递归清理。 */
  release(input: { ownerId: string; attachId: string; creationReceipt: string }): Promise<void>
}
export interface TelegramMediaIngressInput {
  ownerId: string
  botId: string
  platformMessageId: string | null
  attachments: readonly unknown[]
  quotedAttachments: readonly unknown[]
}
function validAttachment(value: { ownerId: string; attachId: string }, ownerId: string): boolean {
  return value.ownerId === ownerId && typeof value.attachId === 'string' && !!value.attachId && value.attachId.length <= 512 && !/[\x00-\x1f\x7f]/.test(value.attachId)
}

export function createTelegramMediaIngress(options: {
  api?: Pick<ReturnType<typeof createTelegramBotApi>, 'call' | 'downloadFile'>
  /** 从可信Bot库检查owner/platform/enabled后解密，只在内存返回token。 */
  resolveToken(input: { ownerId: string; botId: string }, signal?: AbortSignal): Promise<string | null>
  storage: TelegramMediaStorage
}) {
  const ownedApi = options.api ? null : createTelegramBotApi()
  const api = options.api ?? ownedApi!
  const closing = new AbortController()
  const checkCancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new TelegramMediaIngressError('cancelled') }
  return {
    async ingest(input: TelegramMediaIngressInput, signal?: AbortSignal): Promise<{ attachmentIds: string[]; sizeLimitExceeded: boolean; failureNotice: string | null }> {
      signal = AbortSignal.any([closing.signal, ...(signal ? [signal] : [])])
      // owner/Bot/来源在第一次await前固定，调用方修改原对象不能更换暂存归属。
      input = { ...input }
      const raw = input.attachments.filter(object).map(item => ({ ...item })), quoted = input.quotedAttachments.filter(object).map(item => ({ ...item }))
      if (!input.ownerId || !input.botId) return { attachmentIds: [], sizeLimitExceeded: false, failureNotice: raw.length ? downloadNotice : null }
      const attachmentIds: string[] = [], created: { ownerId: string; attachId: string; creationReceipt: string }[] = []
      try {
        checkCancelled(signal)
        for (const item of quoted) {
          checkCancelled(signal)
          const reference = telegramAttachmentReference(item)
          if (!reference) continue
          let reused: { ownerId: string; attachId: string; created?: boolean; creationReceipt?: string } | null
          try { reused = await options.storage.reuse({ ownerId: input.ownerId, botId: input.botId, platform: 'telegram', platformMessageId: reference.sourceMessageId, attachmentIndex: reference.sourceIndex, quoted: true }, signal) }
          catch { checkCancelled(signal); throw new TelegramMediaIngressError('reuse_failed') }
          if (reused) {
            if (!validAttachment(reused, input.ownerId)) throw new TelegramMediaIngressError('storage_contract')
            if (reused.created) {
              if (!reused.creationReceipt) throw new TelegramMediaIngressError('storage_contract')
              created.push({ ownerId: input.ownerId, attachId: reused.attachId, creationReceipt: reused.creationReceipt })
            }
            attachmentIds.push(reused.attachId)
          }
        }
        checkCancelled(signal)
        if (!raw.length) return { attachmentIds, sizeLimitExceeded: false, failureNotice: null }
        let token: string | null
        try { token = await options.resolveToken({ ownerId: input.ownerId, botId: input.botId }, signal) }
        catch { checkCancelled(signal); token = null }
        checkCancelled(signal)
        if (!token) return { attachmentIds, sizeLimitExceeded: false, failureNotice: downloadNotice }
        const result = await processTelegramAttachments(api, token, raw, signal, async (file, signal) => {
          const staged = await options.storage.stage({ ...file, ownerId: input.ownerId, botId: input.botId,
            platform: 'telegram', platformMessageId: input.platformMessageId }, signal)
          if (!staged || !validAttachment(staged, input.ownerId) || typeof staged.created !== 'boolean' || staged.created && (typeof staged.creationReceipt !== 'string' || !staged.creationReceipt))
            throw new TelegramMediaIngressError('storage_contract')
          if (staged.created) created.push({ ownerId: input.ownerId, attachId: staged.attachId, creationReceipt: staged.creationReceipt! })
          checkCancelled(signal)
          attachmentIds.push(staged.attachId)
        })
        return { attachmentIds, ...result }

      } catch (error) {
        if (!await rollbackImMedia(created, item => options.storage.release(item))) throw new TelegramMediaIngressError('cleanup_failed')
        if (error instanceof TelegramMediaIngressError) throw error
        throw new TelegramMediaIngressError('storage_contract')
      }
    },
    async close(): Promise<void> {
      closing.abort()
      try { await ownedApi?.close() } catch { throw new TelegramMediaIngressError('close_failed') }
    },
  }
}
