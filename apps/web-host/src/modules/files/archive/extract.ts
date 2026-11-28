import { CoreError } from '@gugu/core'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import * as tar from 'tar'
import { MAX_ARCHIVE_ENTRIES, MAX_EXTRACT_BYTES, safeArchivePath, splitArchiveFilename } from './rules.js'

export type ExtractedMember = { archivePath: string; kind: 'file' | 'folder'; size: number; stagedPath?: string }

function validateMemberName(name: string, directory: boolean): string {
  const parts = name.split('/')
  const directories = directory ? parts : parts.slice(0, -1)
  const filename = directory ? null : parts.at(-1)
  if (directories.some((part) => part.length > 200)) throw new CoreError('invalid_request', '压缩包损坏')
  if (filename !== null && filename !== undefined) {
    const split = splitArchiveFilename(filename)
    if (split.displayName.length > 300 || split.ext.length > 20) throw new CoreError('invalid_request', '压缩包损坏')
  }
  return name
}

export async function extractZip(zipPath: string, stageDirectory: string): Promise<{ members: ExtractedMember[]; skipped: number }> {
  const unzipper = await import('unzipper')
  const directory = await unzipper.Open.file(zipPath)
  if (directory.files.length > MAX_ARCHIVE_ENTRIES) throw new CoreError('conflict', '压缩包条目过多')
  const members: ExtractedMember[] = []
  let skipped = 0
  let declaredTotal = 0
  const valid = directory.files.map((entry, index) => {
    const archivePath = safeArchivePath(entry.path)
    const isDirectory = entry.type === 'Directory' || entry.path.endsWith('/')
    const metadata = entry as unknown as {
      flags?: number; uncompressedSize?: number; externalFileAttributes?: number
      vars?: { flags?: number; uncompressedSize?: number; externalFileAttributes?: number }
    }
    const values = metadata.vars ?? metadata
    const mode = Number(values.externalFileAttributes ?? 0) >>> 16
    const symlink = (mode & 0o170000) === 0o120000
    if ((values.flags ?? 0) & 0x1) throw new CoreError('invalid_request', '不支持加密压缩包')
    const size = isDirectory || symlink ? 0 : Number(values.uncompressedSize)
    if (!Number.isSafeInteger(size) || size < 0) throw new CoreError('invalid_request', '压缩包损坏')
    validateMemberName(archivePath, isDirectory)
    declaredTotal += size
    if (symlink) skipped += 1
    return { entry, index, archivePath, isDirectory, symlink, size }
  })
  if (declaredTotal > MAX_EXTRACT_BYTES) throw new CoreError('conflict', '解压内容超过安全上限')
  let total = 0
  for (const item of valid) {
    if (!item.archivePath) continue
    if (item.symlink) continue
    if (item.isDirectory) {
      members.push({ archivePath: item.archivePath, kind: 'folder', size: 0 })
      continue
    }
    const stagedPath = path.join(stageDirectory, `zip-${item.index}`)
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length
      if (total > MAX_EXTRACT_BYTES || total > declaredTotal) return callback(new CoreError('conflict', '解压内容超过安全上限'))
      callback(null, chunk)
    } })
    await pipeline(item.entry.stream(), meter, createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }))
    const info = await stat(stagedPath)
    if (info.size !== item.size) throw new CoreError('invalid_request', '压缩包损坏')
    members.push({ archivePath: item.archivePath, kind: 'file', size: info.size, stagedPath })
  }
  return { members, skipped }
}

export async function extractTar(archivePath: string, stageDirectory: string, gzip: boolean): Promise<{ members: ExtractedMember[]; skipped: number }> {
  const parser = new tar.Parser({ strict: true })
  const members: ExtractedMember[] = []
  let skipped = 0
  let count = 0
  let total = 0
  let actualTotal = 0
  let failure: unknown
  const entryTasks: Promise<void>[] = []
  const done = new Promise<void>((resolve) => {
    parser.on('error', (error) => { failure = error })
    parser.on('end', resolve)
    parser.on('entry', (entry) => {
      const index = count++
      if (count > MAX_ARCHIVE_ENTRIES) {
        entry.resume()
        parser.abort(new CoreError('conflict', '压缩包条目过多'))
        return
      }
      let memberName: string
      try { memberName = safeArchivePath(entry.path) }
      catch (error) { entry.resume(); parser.abort(error as Error); return }
      const directory = entry.type === 'Directory'
      const file = entry.type === 'File'
      const supported = directory || file
      const size = file ? Number(entry.size) : 0
      try {
        if (!Number.isSafeInteger(size) || size < 0) throw new CoreError('invalid_request', '压缩包损坏')
        if (supported && memberName) validateMemberName(memberName, directory)
        total += size
        if (total > MAX_EXTRACT_BYTES) throw new CoreError('conflict', '解压内容超过安全上限')
      } catch (error) { entry.resume(); parser.abort(error as Error); return }
      if (!supported || !memberName) {
        skipped += supported ? 0 : 1
        entry.resume()
        return
      }
      if (directory) {
        members.push({ archivePath: memberName, kind: 'folder', size: 0 })
        entry.resume()
        return
      }
      const stagedPath = path.join(stageDirectory, `tar-${index}`)
      let actualFileTotal = 0
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        const actual = chunk.length
        actualFileTotal += actual
        actualTotal += actual
        if (actualFileTotal > size || actualTotal > total || actualTotal > MAX_EXTRACT_BYTES)
          return callback(new CoreError('conflict', '解压内容超过安全上限'))
        callback(null, chunk)
      } })
      const entryTask = pipeline(entry, meter, createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }))
        .then(async () => {
          const info = await stat(stagedPath)
          if (info.size !== size) throw new CoreError('invalid_request', '压缩包损坏')
          members.push({ archivePath: memberName, kind: 'file', size: info.size, stagedPath })
        })
        .catch((error) => { failure = error; parser.abort(error as Error) })
      entryTasks.push(entryTask)
    })
  })
  const input = createReadStream(archivePath)
  if (gzip) await pipeline(input, createGunzip(), parser)
  else await pipeline(input, parser)
  await done
  await Promise.all(entryTasks)
  if (failure) throw failure
  return { members, skipped }
}
