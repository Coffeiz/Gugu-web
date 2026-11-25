import { openLocalFile, UnsafeLocalPathError } from '@gugu/fs/node'
import type { CurrentTurnAttachment } from '@gugu/core/agent'
import { isOwnedFilePath } from '../../files/store.js'
import type { Pool, QueryResultRow } from 'pg'

export interface CurrentMessageAttachmentReaderOptions {
  pool: Pick<Pool, 'query'>
  storageRoot: string
  /** 由格式专用 Core/Host Office 适配器提供；缺失格式明确失败，不把二进制解码成乱码。 */
  extractDocumentText?: (bytes: Uint8Array, extension: string) => Promise<string>
}

const textExtensions = new Set([
  'md','txt','json','csv','yaml','yml','log','py','js','ts','tsx','jsx','vue','html','css','scss',
  'java','go','rs','c','cpp','h','hpp','sh','sql','xml','toml','ini','conf','env','tex',
])
const officeExtensions = new Set(['pdf','docx','doc','odt','rtf','xlsx','xls','ods','pptx','ppt','odp'])
function truncateText(text: string, maximum: number): string {
  const characters: string[] = []
  for (const character of text) {
    if (characters.length >= maximum) break
    characters.push(character)
  }
  return characters.join('')
}
export interface CurrentMessageAttachment extends CurrentTurnAttachment {
  readonly storage_key: string
}
type CurrentMessageAttachmentRow = QueryResultRow & CurrentMessageAttachment & { state: 'attached'; message_id: string | number; extra: Record<string, unknown> | null }

/**
 * 当前消息附件必须同时属于认证 owner、当前消息且已经在发送事务中 claim。
 * storage_key 只从数据库取出，并在 Local 授权根及 owner 前缀内打开。
 */
export function createCurrentMessageAttachmentReader(options: CurrentMessageAttachmentReaderOptions) {
  if (!options.storageRoot?.trim()) throw new TypeError('聊天附件存储根目录未配置')

  return async function read(owner: string, messageId: string, cards: unknown): Promise<{
    attachments: CurrentMessageAttachment[]
    readText(attachment: CurrentTurnAttachment): Promise<string>
  }> {
    if (!owner || !/^[1-9]\d*$/.test(messageId) || !Number.isSafeInteger(Number(messageId))) throw new TypeError('聊天附件身份无效')
    const orderedCards = Array.isArray(cards) ? cards.flatMap(item => {
      if (!item || typeof item !== 'object' || typeof (item as Record<string, unknown>).attach_id !== 'string') return []
      return [item as Record<string, unknown>]
    }) : []
    const result = await options.pool.query<CurrentMessageAttachmentRow>(`SELECT attach_id,name,ext,mime,size,storage_key,kind,duration,img_width,img_height,extra,state,message_id
      FROM chat_attachments WHERE user_id=$1 AND message_id=$2 AND state='attached'`, [owner, Number(messageId)])
    const byId = new Map(result.rows.map(row => [row.attach_id, row]))
    const attachments: CurrentMessageAttachment[] = orderedCards.flatMap(card => {
      const row = byId.get(card.attach_id as string)
      if (!row || row.message_id !== Number(messageId)) return []
      return [{ ...row, qq_face: card.qq_face === true, quoted: card.quoted === true }]
    })

    async function readText(input: CurrentTurnAttachment): Promise<string> {
      const attachment = attachments.find(item => item.attach_id === input.attach_id)
      if (!attachment) throw new Error('附件不属于当前消息')
      const size = Number(attachment.size)
      if (!Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 * 1024) throw new Error('附件文本读取超限')
      if (!isOwnedFilePath(owner, attachment.storage_key)) throw new Error('附件归属不匹配')
      const opened = await openLocalFile(options.storageRoot, attachment.storage_key)
      if (!opened) throw new Error('附件文件不可用')
      try {
        if (opened.size !== size || opened.size > 32 * 1024 * 1024) throw new Error('附件文件大小与元数据不匹配')
        const bytes = await opened.handle.readFile()
        if (bytes.byteLength !== size) throw new Error('附件文件大小与元数据不匹配')
        const extension = attachment.ext.toLowerCase()
        if (textExtensions.has(extension)) return truncateText(new TextDecoder('utf-8').decode(bytes), 200_000)
        if (officeExtensions.has(extension) && options.extractDocumentText) return truncateText(await options.extractDocumentText(bytes, extension), 200_000)
        throw new Error(extension === 'doc' || extension === 'ppt' ? '旧式 Office 文件不支持提取' : 'Office 文本提取器未配置')
      } catch (error) {
        if (error instanceof UnsafeLocalPathError) throw error
        throw error
      } finally { await opened.handle.close() }
    }

    return { attachments, readText }
  }
}
