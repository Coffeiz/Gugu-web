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
  filePaths: readonly string[]
  generated: readonly unknown[]
}

type Source = {
  size: number
  read(limit: number): Promise<Uint8Array>
  close(): Promise<void>
}

export interface EmailAttachmentSources {
  openPath(ownerId: string, path: string): Promise<(Source & { filename: string; mimeType: string }) | null>
  openGenerated(ownerId: string, id: string): Promise<(Source & { filename: string; mimeType: string }) | null>
  guessMimeType(filename: string): string | false
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

/** 仅从当前 owner 的逻辑路径和本轮产物引用取附件，并同时校验申报大小和实际字节。 */
export function createEmailAttachmentResolver(sources: EmailAttachmentSources) {
  return async (rawOwnerId: string, references: EmailAttachmentReferences): Promise<EmailAttachment[]> => {
    const ownerId = dataContext(rawOwnerId).ownerId
    const generated = references.generated.filter((value): value is Record<string, unknown> =>
      value != null && typeof value === 'object' && !Array.isArray(value))
    const paths = [...new Set([...references.filePaths, ...generated.flatMap(item => typeof item.file_path === 'string' && item.file_path.trim()
      ? [item.file_path] : [])])]
    if (references.filePaths.length > maxCount || references.filePaths.some(path => typeof path !== 'string' || !path.startsWith('/')))
      throw new EmailAttachmentError('邮件附件路径无效')
    const attachIds = [...new Set(generated.flatMap(item => typeof item.attach_id === 'string' && item.file_path == null
      && item.attach_id.trim() ? [item.attach_id.trim()] : []))]
    if (paths.length + attachIds.length > maxCount) throw new EmailAttachmentError('附件最多 5 个')
    if (generated.length !== references.generated.length || generated.some(item =>
      [typeof item.file_path === 'string' && Boolean(item.file_path.trim()),
        typeof item.attach_id === 'string' && Boolean(item.attach_id.trim())].filter(Boolean).length !== 1))
      throw new EmailAttachmentError('本轮生成的附件已过期，无法添加到邮件')

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

    for (const path of paths) {
      const error = '路径附件不存在或不可读取'
      const source = await sources.openPath(ownerId, path)
      if (!source) throw new EmailAttachmentError(error)
      await add(source, filename(source.filename, '', 'attachment'), source.mimeType, error)
    }
    for (const id of attachIds) {
      const source = await sources.openGenerated(ownerId, id)
      if (!source) throw new EmailAttachmentError('本轮生成的附件已过期，无法添加到邮件')
      await add(source, filename(source.filename, '', `attachment-${id.slice(0, 12)}`), source.mimeType, '本轮生成的附件内容读取失败')
    }
    return result
  }
}
