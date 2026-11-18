import { dataContext } from '../contracts/index.js'

const maxCount = 5
const maxPart = 10 * 1024 * 1024
const maxTotal = 25 * 1024 * 1024

export class EmailAttachmentError extends Error {}

export interface EmailAttachment {
  filename: string
  content: Uint8Array
  mimeType: string
}

export interface EmailAttachmentReferences {
  fileIds: readonly number[]
  generated: readonly unknown[]
}

type Metadata = {
  id: number
  storageKey: string
  name: string
  ext: string
  mimeType: string | null
  size: number
}

type Source = {
  size: number
  read(limit: number): Promise<Uint8Array>
  close(): Promise<void>
}

export interface EmailAttachmentSources {
  files(ownerId: string, ids: readonly number[]): Promise<readonly Metadata[]>
  openFile(ownerId: string, file: Metadata): Promise<Source | null>
  openGenerated(ownerId: string, id: string): Promise<(Source & { filename: string; mimeType: string }) | null>
  guessMimeType(filename: string): string | false
}

function normalizeIds(ids: readonly unknown[]): number[] {
  if (ids.length > maxCount) throw new EmailAttachmentError('附件最多 5 个')
  return [...new Set(ids.map(id => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
      throw new EmailAttachmentError('file_ids 只能包含正整数 file_id')
    return id
  }))]
}

function filename(name: string, ext: string, fallback: string): string {
  const base = name.split(/[\\/]/u).at(-1)?.replace(/[\x00-\x1f\x7f]+/gu, '_').replace(/^[ .]+|[ .]+$/gu, '') || fallback
  const suffix = ext.trim().replace(/^\.+/u, '').replace(/[^A-Za-z0-9.+_-]/gu, '')
  const fullName = suffix && !base.toLowerCase().endsWith(`.${suffix.toLowerCase()}`) ? `${base}.${suffix}` : base
  return Array.from(fullName).slice(0, 200).join('')
}

function checkSize(size: number, total: number): void {
  if (size > maxPart) throw new EmailAttachmentError('附件单个不能超过 10MB')
  if (total + size > maxTotal) throw new EmailAttachmentError('附件总大小不能超过 25MB')
}

/** 仅从当前 owner 的文件记录和本轮产物引用取附件，并同时校验申报大小和实际字节。 */
export function createEmailAttachmentResolver(sources: EmailAttachmentSources) {
  return async (rawOwnerId: string, references: EmailAttachmentReferences): Promise<EmailAttachment[]> => {
    const ownerId = dataContext(rawOwnerId).ownerId
    const generated = references.generated.filter((value): value is Record<string, unknown> =>
      value != null && typeof value === 'object' && !Array.isArray(value))
    const savedIds = normalizeIds(references.fileIds)
    const generatedFileIds = normalizeIds(generated.flatMap(item => item.file_id == null ? [] : [item.file_id]))
    const fileIds = [...new Set([...savedIds, ...generatedFileIds])]
    const attachIds = [...new Set(generated.flatMap(item => typeof item.attach_id === 'string' && item.file_id == null
      && item.attach_id.trim() ? [item.attach_id.trim()] : []))]
    if (fileIds.length + attachIds.length > maxCount) throw new EmailAttachmentError('附件最多 5 个')
    if (generated.length !== references.generated.length || generated.some(item =>
      item.file_id == null && (typeof item.attach_id !== 'string' || !item.attach_id.trim())))
      throw new EmailAttachmentError('本轮生成的附件已过期，无法添加到邮件')

    const files = new Map((fileIds.length ? await sources.files(ownerId, fileIds) : []).map(file => [file.id, file]))
    if (fileIds.some(id => !files.has(id)))
      throw new EmailAttachmentError('附件不存在、已删除或不属于当前用户')

    let total = 0
    const result: EmailAttachment[] = []
    async function add(source: Source, name: string, rawMimeType: string | null, readError: string) {
      let content: Uint8Array
      try {
        checkSize(source.size, total)
        try { content = await source.read(Math.min(maxPart, maxTotal - total) + 1) }
        catch { throw new EmailAttachmentError(readError) }
        checkSize(content.byteLength, total)
      } finally { await source.close() }
      total += content.byteLength
      const declared = rawMimeType?.trim().toLowerCase() ?? ''
      const mimeType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(declared) ? declared : sources.guessMimeType(name) || 'application/octet-stream'
      result.push({ filename: name, content, mimeType })
    }

    for (const id of fileIds) {
      const file = files.get(id)!
      checkSize(file.size, total)
      const readError = '附件内容读取失败，文件可能已丢失'
      const source = await sources.openFile(ownerId, file).catch(() => null)
      if (!source) throw new EmailAttachmentError(readError)
      await add(source, filename(file.name, file.ext, `attachment-${id}`), file.mimeType, readError)
    }
    for (const id of attachIds) {
      const source = await sources.openGenerated(ownerId, id)
      if (!source) throw new EmailAttachmentError('本轮生成的附件已过期，无法添加到邮件')
      await add(source, filename(source.filename, '', `attachment-${id.slice(0, 12)}`), source.mimeType, '本轮生成的附件内容读取失败')
    }
    return result
  }
}
