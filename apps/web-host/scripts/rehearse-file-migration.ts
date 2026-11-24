import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { createLocalFileTree, openAnchoredLocalFile } from '@gugu/fs/node'
import { resolveConfigOverridePath } from '../src/adapters/config/config-override-file.js'
import { loadConfig } from '../src/config.js'
import { normalizeOwnerId } from '../src/shared/owner-context.js'
import { createFileMigrationStorage } from '../src/modules/files/storage/migration.js'
import { createDiskTrash } from '../src/modules/files/trash/disk.js'
import type { FileDirectory } from '../src/modules/workspaces/files.js'

async function digest(handle: FileHandle) {
  const hash = createHash('sha256')
  for await (const chunk of handle.createReadStream()) hash.update(chunk)
  return hash.digest('hex')
}

async function rehearse(file: string) {
  if (process.platform !== 'linux' || !isAbsolute(file)) throw new Error('需要 Linux 环境和清单绝对路径')
  const config = loadConfig(process.env, resolveConfigOverridePath(process.env))
  const root = await mkdtemp(join(tmpdir(), 'gugu-file-migration-rehearsal-'))
  const report = { references: 0, restores: 0, blocked: 0, folderRecords: 0, folderPaths: 0 }
  const storage = createFileMigrationStorage(root)
  const rows = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  try {
    let hasHeader = false
    for await (const line of rows) {
      const row = JSON.parse(line)
      if (!hasHeader) {
        if (row.kind !== 'header' || row.version !== 3) throw new Error('迁移清单版本无效')
        hasHeader = true
        continue
      }
      if (row.kind === 'folder') {
        report.folderRecords++
        const owner = normalizeOwnerId(row.legacy.user_id)
        const key: unknown = row.storageKey
        if (row.legacy.deleted_at || typeof key !== 'string') { report.blocked++; continue }
        const parts = key.split('/')
        if (parts[0] !== owner || !['个人文件', '项目文件', 'workspace'].includes(parts[1] ?? '')
          || parts.length < 3 || parts.some(part => !part || part === '.' || part === '..'
            || part.startsWith('.gugu-') || /[\\\0]/u.test(part))) throw new Error('清单目录归属不合法')
        if (!await createLocalFileTree(root, key).ensureRoot()) throw new Error('无法创建迁移目录')
        report.folderPaths++
        continue
      }
      if (row.kind !== 'file') throw new Error('迁移清单条目无效')
      if (row.state !== 'inPlace' || (row.legacy.deleted_at && (!row.restoreKey || !row.restoreTarget))) {
        report.blocked++
        continue
      }
      const owner = normalizeOwnerId(row.legacy.user_id)
      const key: string = row.legacy.storage_key
      if (typeof key !== 'string' || !key.startsWith(`${owner}/`) || key.split('/').some(segment =>
        !segment || segment === '.' || segment === '..' || segment.startsWith('.gugu-') || /[\\\0]/.test(segment)))
        throw new Error('清单文件归属不合法')
      const source = await openAnchoredLocalFile(config.storageLocalPath, key)
      if (!source) { report.blocked++; continue }
      const target = createLocalFileTree(root, dirname(key))
      const hash = createHash('sha256')
      try {
        if (!await target.ensureRoot()) throw new Error('演练目录不可用')
        const bytes = async function* () {
          for await (const chunk of source.handle.createReadStream({ autoClose: false })) {
            hash.update(chunk)
            yield chunk as Uint8Array
          }
        }
        await target.upload(basename(key), bytes(), new AbortController().signal)
      } finally { await source.handle.close() }
      await storage.install(owner, {
        id: row.legacy.id, storageKey: key, displayName: row.legacy.display_name,
        deletedAt: row.legacy.deleted_at, restoreKey: row.restoreKey ?? null,
      })
      if (row.legacy.deleted_at) {
        const { directory, relativePath } = row.restoreTarget as { directory: FileDirectory; relativePath: string }
        const suffix = `/${relativePath}`
        if (!row.restoreKey.endsWith(suffix)) throw new Error('回收项路径与清单不一致')
        const restoredRoot: string = row.restoreKey.slice(0, -suffix.length)
        const trash = createDiskTrash(root, async () => restoredRoot)
        const trashId = await trash.importLegacy(owner, row.legacy.id, directory, relativePath, key, row.legacy.deleted_at)
        if (await trash.importLegacy(owner, row.legacy.id, directory, relativePath, key, row.legacy.deleted_at) !== trashId
          || !(await trash.list(owner)).some(entry => entry.id === trashId) || !await trash.restore(owner, trashId))
          throw new Error('无法从磁盘回收站还原旧回收项')
        report.restores++
      }
      const opened = await storage.openReference(owner, row.legacy.id)
      if (!opened || await digest(opened.handle) !== hash.digest('hex'))
        throw new Error('按旧文件标识打开的内容与来源不一致')
      report.references++
    }
    if (!hasHeader) throw new Error('迁移清单为空')
    return report
  } finally {
    rows.close()
    await rm(root, { recursive: true, force: true })
  }
}

rehearse(process.argv[2] ?? '').then(report => {
  console.log(JSON.stringify(report, null, 2))
  if (report.blocked) process.exitCode = 2
}).catch(() => {
  console.error('文件迁移演练失败。请核对清单、磁盘内容和存储配置。')
  process.exitCode = 1
})
