import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'
import type { EmailAttachment } from '../../../../../packages/core/src/email/attachments.js'
import { openDroppedFile } from '../../../../../packages/core/src/runtime/desktop-file-excerpt.js'

const maxPart = 10 * 1024 * 1024
const maxTotal = 25 * 1024 * 1024
const maxCount = 5
const mimeTypes: Readonly<Record<string, string>> = {
  '.csv': 'text/csv', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.json': 'application/json', '.md': 'text/markdown',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.png': 'image/png', '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.txt': 'text/plain', '.wav': 'audio/wav',
  '.webp': 'image/webp', '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.zip': 'application/zip',
}

export type DesktopMailFileReference = (id: string) => Promise<{ path: string; fileIdentity: string } | null>

export function desktopMailAttachmentDigest(files: readonly EmailAttachment[]): string {
  return createHash('sha256').update(JSON.stringify(files.map(file => ({
    filename: file.filename,
    mimeType: file.mimeType,
    digest: createHash('sha256').update(file.content).digest('hex'),
  })))).digest('hex')
}

/** 只读取本轮已授权引用，并在发件时重新校验文件身份和内容。 */
export function createDesktopMailAttachmentResolver(resolveReference: DesktopMailFileReference) {
  return async (references: readonly string[], signal?: AbortSignal): Promise<EmailAttachment[]> => {
    if (references.length > maxCount || new Set(references).size !== references.length)
      throw new Error('邮件附件数量或引用无效')
    const result: EmailAttachment[] = []
    let total = 0
    for (const reference of references) {
      signal?.throwIfAborted()
      const file = await resolveReference(reference)
      if (!file) throw new Error('本机邮件附件已移动或无法访问')
      const opened = await openDroppedFile(file.path, file.fileIdentity, signal)
      if (!opened) throw new Error('本机邮件附件已移动或替换')
      try {
        if (opened.size > maxPart || total + opened.size > maxTotal)
          throw new Error('邮件附件超过大小限制')
        const bytes = Buffer.allocUnsafe(Math.min(maxPart, maxTotal - total) + 1)
        const { bytesRead } = await opened.handle.read(bytes, 0, bytes.length, 0)
        if (bytesRead > maxPart || total + bytesRead > maxTotal)
          throw new Error('邮件附件超过大小限制')
        total += bytesRead
        const name = Array.from(basename(file.path).replace(/[\\/\p{Cc}\p{Cf}]/gu, '_')).slice(0, 200).join('') || 'attachment'
        const extension = extname(name).toLowerCase()
        result.push({ filename: name, content: bytes.subarray(0, bytesRead), mimeType: mimeTypes[extension] ?? 'application/octet-stream' })
      } finally {
        await opened.handle.close()
      }
    }
    signal?.throwIfAborted()
    return result
  }
}
