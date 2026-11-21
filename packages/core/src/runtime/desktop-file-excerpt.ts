import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { extractOfficeText, OFFICE_TEXT_EXTENSIONS, OFFICE_TEXT_MAX_BYTES } from '../files/office-text.js'

const textExtensions = new Set(['txt', 'md', 'csv', 'json', 'yaml', 'yml', 'log', 'xml', 'ts', 'js', 'py', 'rs', 'go', 'html', 'css', 'sql'])
const textByteLimit = 4800

export async function openDroppedFile(path: string, identity: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (!isAbsolute(path)) return null
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat({ bigint: true })
    if (info.isFile() && [info.dev, info.ino, info.birthtimeNs].join('.') === identity)
      return { handle, size: Number(info.size) }
  } catch (error) {
    await handle.close()
    throw error
  }
  await handle.close()
  return null
}

/** 仅接收宿主确认的文件定位，并在实际文件句柄上复核原件身份。 */
export async function readDroppedFileExcerpt(path: string, identity: string, signal?: AbortSignal) {
  const name = basename(path)
  const extension = extname(name).slice(1).toLowerCase()
  const office = OFFICE_TEXT_EXTENSIONS.has(extension)
  const plain = textExtensions.has(extension)
  try {
    const opened = await openDroppedFile(path, identity, signal)
    if (!opened) return null
    const { handle, size } = opened
    try {
      if ((!office && !plain) || (office && size > OFFICE_TEXT_MAX_BYTES)) return { name, text: null }
      const bytes = Buffer.alloc(office ? size : textByteLimit)
      let read = 0
      while (read < bytes.length) {
        signal?.throwIfAborted()
        const chunk = await handle.read(bytes, read, bytes.length - read, read)
        if (!chunk.bytesRead) break
        read += chunk.bytesRead
      }
      const source = new Uint8Array(bytes.buffer, bytes.byteOffset, read)
      const text = office ? await extractOfficeText(source, extension)
        : new TextDecoder('utf-8', { fatal: true }).decode(source, { stream: read === textByteLimit })
      signal?.throwIfAborted()
      return { name, text: text.includes('\0') ? null : text }
    } finally { await handle.close() }
  } catch (error) {
    signal?.throwIfAborted()
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
    return { name, text: null }
  }
}
