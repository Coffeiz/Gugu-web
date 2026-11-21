import { FeishuApiError, type createFeishuClient } from './client.js'

type ObjectValue = Record<string, unknown>
type Outcome = 'accepted' | 'rejected' | 'unknown'
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const clip = (value: string, size: number): string => [...value].slice(0, size).join('')
const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
const imageMimes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }

export interface FeishuDeliveryReceipt { outcome: Outcome; platformMessageIds: readonly string[] }
export interface FeishuPrompt {
  prompt_id: number
  title?: string
  body?: string
  options?: readonly { id?: string; label?: string; token?: string }[]
}
const rejected = (): FeishuDeliveryReceipt => ({ outcome: 'rejected', platformMessageIds: [] })
function failure(error: unknown): Outcome {
  return error instanceof FeishuApiError && (error.operation === 'auth' || error.errorCode !== undefined && error.errorCode !== 0 ||
    error.statusCode !== undefined && error.statusCode >= 300 && error.statusCode < 500) ? 'rejected' : 'unknown'
}
function responseKey(response: ObjectValue, name: string): string | null {
  const value = object(response.data) ? response.data[name] : undefined
  return typeof value === 'string' && value.trim() ? value : null
}
function validRecipient(value: string): boolean { return /^(?:ou_|oc_)[A-Za-z0-9_-]{1,256}$/.test(value) }
function validMessageId(value: string): boolean { return /^[A-Za-z0-9_-]{1,256}$/.test(value) }

export function feishuFileType(ext: string): string {
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return ({ docx: 'doc', xlsx: 'xls', pptx: 'ppt' } as Record<string, string>)[ext] ?? ext
  if (ext === 'ogg' || ext === 'opus') return 'opus'
  return ext === 'mp4' ? 'mp4' : 'stream'
}

function splitRow(line: string): string[] { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(value => value.trim()) }
function parseTable(block: string[]): ObjectValue | null {
  const lines = block.filter(line => line.trim()), separator = lines.findIndex(line => /^\s*\|[\s\-:|]+\|\s*$/.test(line))
  if (lines.length < 2 || separator <= 0) return null
  const headers = splitRow(lines[0]!), aligns = splitRow(lines[separator]!)
  const columns = headers.map((header, index) => ({ name: `col${index}`, display_name: header, width: 'auto',
    horizontal_align: aligns[index]?.startsWith(':') && aligns[index]?.endsWith(':') ? 'center' : aligns[index]?.endsWith(':') ? 'right' : 'left' }))
  const rows = lines.slice(separator + 1).map(line => {
    const cells = splitRow(line)
    return Object.fromEntries(headers.map((_header, index) => [`col${index}`, (cells[index] ?? '').replace(/[*_]{1,2}(.+?)[*_]{1,2}/g, '$1')]))
  })
  return rows.length ? { tag: 'table', page_size: Math.min(Math.max(rows.length, 10), 50), columns, rows } : null
}

/** 普通卡片与Python一致：表格为原生组件，只有首个Markdown拥有streaming element_id。 */
export function buildFeishuCardElements(text: string): ObjectValue[] {
  const lines = text.split('\n'), elements: ObjectValue[] = []
  let assigned = false, index = 0
  const append = (content: string) => {
    const value: ObjectValue = { tag: 'markdown', content: content.replace(/^#{1,6}\s+(.+)$/gm, '**$1**') }
    if (!assigned) { value.element_id = 'markdown_1'; assigned = true }
    elements.push(value)
  }
  while (index < lines.length) {
    const table = /^\s*\|/.test(lines[index]!), block: string[] = []
    while (index < lines.length && /^\s*\|/.test(lines[index]!) === table) block.push(lines[index++]!)
    if (table) { const parsed = parseTable(block); if (parsed) elements.push(parsed); else append(block.join('\n')) }
    else { const content = block.join('\n').trim(); if (content) append(content) }
  }
  if (!elements.length) append(text)
  return elements
}

export function createFeishuSender(options: { client: Pick<ReturnType<typeof createFeishuClient>, 'call'> }) {
  async function send(receiveId: string, type: string, content: ObjectValue, signal?: AbortSignal,authorize?:()=>Promise<boolean>): Promise<FeishuDeliveryReceipt> {
    if (!validRecipient(receiveId)) return rejected()
    try {
      const response = await options.client.call('POST', `/open-apis/im/v1/messages?receive_id_type=${receiveId.startsWith('ou_') ? 'open_id' : 'chat_id'}`, {
        body: { receive_id: receiveId, msg_type: type, content: JSON.stringify(content) }, signal,authorize,
      })
      const id = responseKey(response, 'message_id')
      return { outcome: id ? 'accepted' : 'unknown', platformMessageIds: id ? [id] : [] }
    } catch (error) { return { outcome: failure(error), platformMessageIds: [] } }
  }
  async function uploadImage(data: Uint8Array, signal?: AbortSignal,authorize?:()=>Promise<boolean>): Promise<{ outcome: Outcome; imageKey: string | null }> {
    if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > 100 * 1024 * 1024) return { outcome: 'rejected', imageKey: null }
    try {
      const response = await options.client.call('POST', '/open-apis/im/v1/images', { body: { image_type: 'message' },
        files: { image: { name: 'image', data, contentType: 'application/octet-stream' } }, signal,authorize })
      const key = responseKey(response, 'image_key')
      return { outcome: key ? 'accepted' : 'unknown', imageKey: key }
    } catch (error) { return { outcome: failure(error), imageKey: null } }
  }
  return {
    async text(receiveId: string, text: string, signal?: AbortSignal,authorize?:()=>Promise<boolean>): Promise<FeishuDeliveryReceipt> {
      const result = await send(receiveId, 'interactive', { elements: buildFeishuCardElements(text) }, signal,authorize)
      // 未知结果不得回退重发，否则上游已接受卡片时会重复回复。
      return result.outcome === 'rejected' && !signal?.aborted ? send(receiveId, 'text', { text }, signal,authorize) : result
    },
    card(receiveId: string, payload: ObjectValue, signal?: AbortSignal): Promise<FeishuDeliveryReceipt> {
      return send(receiveId, 'interactive', payload, signal)
    },
    interaction(receiveId: string, prompt: FeishuPrompt, signal?: AbortSignal,authorize?:()=>Promise<boolean>): Promise<FeishuDeliveryReceipt> {
      if (!Number.isSafeInteger(prompt.prompt_id) || prompt.prompt_id <= 0) return Promise.resolve(rejected())
      const title = clip(prompt.title || '需要你的回答', 120), body = clip(prompt.body || '', 1000)
      const elements: ObjectValue[] = [{ tag: 'markdown', content: `**${title}**${body ? '\n\n' + body : ''}` }]
      const actions = (prompt.options ?? []).filter(option => option.token).map(option => {
        const label = option.label || option.id || '选择', value: ObjectValue = { prompt_id: prompt.prompt_id, token: option.token }
        if (option.id) value.option_id = clip(option.id, 64)
        if (label.trim()) value.label = clip(label.trim(), 120)
        return { tag: 'button', text: { tag: 'plain_text', content: clip(label, 40) }, type: 'primary', value }
      })
      if (actions.length) elements.push({ tag: 'action', actions })
      return send(receiveId, 'interactive', { config: { wide_screen_mode: true }, elements }, signal,authorize)
    },
    linkCard(receiveId: string, text: string, buttons: readonly { label: string; url: string }[], signal?: AbortSignal): Promise<FeishuDeliveryReceipt> {
      try { for (const button of buttons) { const url = new URL(button.url); if (url.protocol !== 'https:' || url.username || url.password) return Promise.resolve(rejected()) } }
      catch { return Promise.resolve(rejected()) }
      const elements: ObjectValue[] = text.trim() ? [{ tag: 'markdown', content: text.trim() }] : []
      elements.push({ tag: 'action', actions: buttons.map(button => ({ tag: 'button', text: { tag: 'plain_text', content: button.label }, type: 'primary', behaviors: [{ type: 'open_url', default_url: button.url }] })) })
      return send(receiveId, 'interactive', { config: { wide_screen_mode: true }, elements }, signal)
    },
    uploadImage,
    async file(chatId: string, data: Uint8Array, name: string, ext: string, signal?: AbortSignal,authorize?:()=>Promise<boolean>): Promise<FeishuDeliveryReceipt> {
      if (!chatId.startsWith('oc_') || !validRecipient(chatId) || !(data instanceof Uint8Array) || !data.byteLength || data.byteLength > 100 * 1024 * 1024) return rejected()
      const extension = ext.toLowerCase(), filename = extension ? `${name}.${extension}` : name
      if (!name || /[\r\n\0"\\/]/.test(filename)) return rejected()
      if (imageExts.has(extension)) {
        const uploaded = await uploadImage(data, signal,authorize)
        return uploaded.imageKey ? send(chatId, 'image', { image_key: uploaded.imageKey }, signal,authorize) : { outcome: uploaded.outcome, platformMessageIds: [] }
      }
      try {
        const response = await options.client.call('POST', '/open-apis/im/v1/files', { body: { file_type: feishuFileType(extension), file_name: filename },
          files: { file: { name: filename, data, contentType: imageMimes[extension] ?? 'application/octet-stream' } }, signal,authorize })
        const key = responseKey(response, 'file_key')
        return key ? send(chatId, 'file', { file_key: key }, signal,authorize) : { outcome: 'unknown', platformMessageIds: [] }
      } catch (error) { return { outcome: failure(error), platformMessageIds: [] } }
    },
    async react(messageId: string, emojiType: string, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<{ outcome: Outcome; reactionId: string | null }> {
      if (!validMessageId(messageId) || !emojiType || /[\r\n\0]/.test(emojiType)) return { outcome: 'rejected', reactionId: null }
      try {
        const response = await options.client.call('POST', `/open-apis/im/v1/messages/${messageId}/reactions`, { body: { reaction_type: { emoji_type: emojiType } }, signal, authorize })
        const id = responseKey(response, 'reaction_id')
        return { outcome: id ? 'accepted' : 'unknown', reactionId: id }
      } catch (error) { return { outcome: failure(error), reactionId: null } }
    },
  }
}
