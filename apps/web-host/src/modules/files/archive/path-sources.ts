import { CoreError } from '@gugu/core'
import { createLocalFileTree } from '@gugu/fs/node'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import { MAX_ARCHIVE_ENTRIES, MAX_COMPRESS_SOURCE_BYTES, safeArchivePath } from './rules.js'
import type { ZipSource } from './write.js'

/** 枚举授权根目录中的路径；读取时重新固定文件句柄。 */
export async function collectPathZipSources(tree: ReturnType<typeof createLocalFileTree>, paths: readonly string[], signal: AbortSignal): Promise<ZipSource[]> {
  if (!paths.length) throw new CoreError('invalid_request', '所选内容为空，无法压缩')
  const sources: ZipSource[] = [], names = new Set<string>()
  let bytes = 0
  async function visit(relativePath: string, archivePath: string, kind: 'directory' | 'file', size: number): Promise<void> {
    signal.throwIfAborted()
    safeArchivePath(archivePath)
    if (names.has(archivePath)) throw new CoreError('conflict', '压缩内容名称冲突')
    names.add(archivePath)
    if (names.size > MAX_ARCHIVE_ENTRIES) throw new CoreError('conflict', '压缩内容过多')
    if (kind === 'directory') {
      sources.push({ kind: 'folder', archivePath })
      const entries = await tree.list(relativePath)
      if (!entries) throw new CoreError('not_found', '文件或目录不存在')
      for (const item of entries) await visit(item.relativePath, `${archivePath}/${item.name}`, item.kind, item.size)
    } else {
      bytes += size
      if (!Number.isSafeInteger(bytes) || bytes > MAX_COMPRESS_SOURCE_BYTES) throw new CoreError('conflict', '内容过大，暂不支持在库内压缩')
      sources.push({ kind: 'file', archivePath, open: () => Readable.from((async function* () {
        signal.throwIfAborted()
        const file = await tree.open(relativePath)
        if (!file) throw new CoreError('not_found', '文件或目录不存在')
        try { for await (const chunk of file.handle.createReadStream({ autoClose: false, signal })) yield chunk }
        finally { await file.handle.close() }
      })()) })
    }
  }
  for (const item of new Set(paths)) {
    if (!item || item.endsWith('/')) throw new CoreError('invalid_request', '文件路径无效')
    const parent = posix.dirname(item), name = posix.basename(item)
    const entries = await tree.list(parent === '.' ? '' : parent)
    const entry = entries?.find(value => value.relativePath === item)
    if (!entry) throw new CoreError('not_found', '文件或目录不存在')
    await visit(item, name, entry.kind, entry.size)
  }
  return sources
}
