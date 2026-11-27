import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { RunIdentity } from '../agent/models.js'
import { createWebDownloadTool, type WebDownloadPort } from '../agent/tools/web/index.js'
import { agentDownloadsLimit, saveAgentDownloadTo } from '../agent/tools/web/download-to-disk.js'

const stagingPrefix = '.gugu-download-'
const stagingRetentionMs = 24 * 60 * 60 * 1000

/** 只回收本应用留下的过期暂存目录，忽略链接和其他文件。 */
export async function cleanupDesktopDownloadStaging(dataRoot: string, now = Date.now()) {
  for (const entry of await readdir(dataRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.gugu-download-[A-Za-z0-9]{6}$/u.test(entry.name)) continue
    const directory = join(dataRoot, entry.name)
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!info?.isDirectory() || info.mtimeMs > now - stagingRetentionMs) continue
    if (process.getuid && info.uid !== process.getuid()) continue
    await rm(directory, { recursive: true, force: true })
  }
}

const extensions = new Map([
  ['application/pdf', 'pdf'], ['application/json', 'json'],
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif'],
  ['text/plain', 'txt'], ['text/html', 'html'], ['text/csv', 'csv'],
])

export function createDesktopWebDownload(options: {
  dataRoot: string
  authorized(identity: RunIdentity): Promise<boolean>
  readTarget(signal: AbortSignal, folderPath?: string): Promise<unknown>
  commit(input: { target: string; stage: string; filename: string; folderPath?: string }, signal: AbortSignal): Promise<unknown>
  open: WebDownloadPort['open']
}) {
  return createWebDownloadTool({
    fixedDestination: true,
    allowFolderPath: true,
    open: options.open,
    extension: type => extensions.get(type) ?? null,
    async prepare({ folderPath }, scope) {
      if (!await options.authorized(scope.identity)) return { error: '下载运行授权已失效' }
      const target = await options.readTarget(scope.signal, folderPath)
      if (typeof target !== 'string' || !target) return { error: '个人文件目录不可用' }
      return {
        capacity: agentDownloadsLimit,
        store: (file, scope, call) => saveAgentDownloadTo(file.name, file.data, scope, call,
          () => options.authorized(scope.identity), async (filename, data, signal) => {
            const directory = await mkdtemp(join(options.dataRoot, stagingPrefix))
            try {
              await pipeline(Readable.from(data, { objectMode: false }),
                createWriteStream(join(directory, 'body'), { flags: 'wx', mode: 0o600 }), { signal })
              signal.throwIfAborted()
              await options.commit({ filename, target, stage: basename(directory), ...(folderPath === undefined ? {} : { folderPath }) }, signal)
            } finally {
              await rm(directory, { recursive: true, force: true })
            }
          }, `/personal/${folderPath ?? 'download'}`),
      }
    },
  })
}
