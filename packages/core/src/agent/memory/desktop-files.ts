import { randomUUID } from 'node:crypto'
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { openLocalFile, UnsafeLocalPathError } from '@gugu/fs/node'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../../data/schema.js'
import { dataContext } from '../../contracts/index.js'
import { imMemoryScopeFileKey, type ImMemoryScopeFile } from '../../im/memory-source.js'

export const desktopMemoryFiles = {
  profile: 'profile.json', pattern: 'pattern.json', facts: 'facts.json', memory: 'memory.md',
  daily: 'daily.md', summary: 'summary.json', stance: 'stance.json', lens: 'lens.json',
} as const

export function createDesktopMemoryFiles(db: Kysely<Database>, root: string, ownerId: string) {
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  const directory = join(root, '.agent', 'memories')
  const read = async (name: string) => {
    const file = await openLocalFile(root, `.agent/memories/${name}`)
    if (!file) return undefined
    try {
      if (file.size > 2_000_000) throw new Error('桌面记忆文件超过读取上限')
      return (await file.handle.readFile({ encoding: 'utf8' }))
    } finally { await file.handle.close() }
  }

  async function publish(name: string, body: string) {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await initialize()
    if (!(await lstat(directory)).isDirectory()) throw new UnsafeLocalPathError()
    const path = join(directory, name)
    const temp = join(directory, `.${randomUUID()}.tmp`)
    try {
      const handle = await open(temp, 'wx', 0o600)
      try { await handle.writeFile(body, 'utf8'); await handle.sync() }
      finally { await handle.close() }
      await rename(temp, path)
    } finally {
      await unlink(temp).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }

  async function publishImScope(scope: ImMemoryScopeFile, filename: string, body: string) {
    const relative = imMemoryScopeFileKey(scope, filename)
    const segments = relative.split('/')
    if (Buffer.byteLength(body) > 2_000_000) throw new Error('IM 记忆文件超过写入上限')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new UnsafeLocalPathError()
    let parent = root
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment)
      try { await mkdir(parent, { mode: 0o700 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      const info = await lstat(parent)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new UnsafeLocalPathError()
    }
    const target = join(parent, segments.at(-1)!)
    const existing = await lstat(target).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new UnsafeLocalPathError()
    const temp = join(parent, `.${randomUUID()}.tmp`)
    try {
      const handle = await open(temp, 'wx', 0o600)
      try { await handle.writeFile(body, 'utf8'); await handle.sync() }
      finally { await handle.close() }
      await rename(temp, target)
    } finally {
      await unlink(temp).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }

  function filename(target: string) {
    return Object.hasOwn(desktopMemoryFiles, target) ? desktopMemoryFiles[target as keyof typeof desktopMemoryFiles] : undefined
  }

  // SQLite 正文行在事务中承担待落盘队列，工具收据与正文变更一起提交。
  // 成功替换文件后才清除待落盘行，进程退出后可重试。
  async function flush() {
    return db.transaction().execute(async tx => {
      const { rows } = await sql<{ target: string; body: string }>`
        SELECT target,body FROM desktop_agent_memory WHERE user_id=${owner}
        UNION ALL SELECT target,body FROM desktop_agent_memory_documents WHERE user_id=${owner}`.execute(tx)
      if (!rows.length) return
      for (const row of rows) {
        const name = filename(row.target)
        if (name) await publish(name, row.body)
      }
      for (const row of rows) {
        if (!filename(row.target)) continue
        await sql`DELETE FROM desktop_agent_memory WHERE user_id=${owner} AND target=${row.target}`.execute(tx)
        await sql`DELETE FROM desktop_agent_memory_documents WHERE user_id=${owner} AND target=${row.target}`.execute(tx)
      }
    })
  }

  async function flushImportedIm() {
    await db.transaction().execute(async tx => {
      const queued = await sql<Omit<ImMemoryScopeFile, 'owner_user_id'> & { filename: string; body: string }>`
        SELECT platform,bot_id,scope_type,scope_id,filename,body FROM desktop_imported_im_memory WHERE owner_id=${owner}
      `.execute(tx)
      for (const { filename, body, ...identity } of queued.rows) {
        const scope = { owner_user_id: ownerId, ...identity }
        const { platform, bot_id, scope_type, scope_id } = identity
        const deleted = await sql`SELECT 1 FROM desktop_im_memory_tombstones WHERE owner_id=${owner}
          AND platform=${platform} AND bot_id=${bot_id} AND scope_type=${scope_type} AND scope_id=${scope_id}`.execute(tx)
        if (!deleted.rows.length && await readImScope(scope, filename) === null) await publishImScope(scope, filename, body)
        await sql`DELETE FROM desktop_imported_im_memory WHERE owner_id=${owner} AND platform=${platform}
          AND bot_id=${bot_id} AND scope_type=${scope_type} AND scope_id=${scope_id} AND filename=${filename}`.execute(tx)
      }
    })
  }

  async function initialize() {
    for (const path of [join(root, '.agent'), directory]) {
      await mkdir(path, { recursive: true, mode: 0o700 })
      if (!(await lstat(path)).isDirectory()) throw new UnsafeLocalPathError()
    }
  }

  const vectorCacheName = 'desktop-memory-vectors.json'
  let vectorWrites = Promise.resolve()
  async function readVectorCache(): Promise<Record<string, unknown>> {
    const body = await read(vectorCacheName)
    if (!body) return {}
    try {
      const parsed: unknown = JSON.parse(body)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch { return {} }
  }

  async function clearFile(name: string, empty: string) {
    const info = await lstat(join(directory, name)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!info) return
    if (!info.isFile()) throw new UnsafeLocalPathError()
    await publish(name, empty)
  }

  async function readImScope(scope: ImMemoryScopeFile, filename: string) {
    const file = await openLocalFile(root, imMemoryScopeFileKey(scope, filename))
    if (!file) return null
    try {
      if (file.size > 2_000_000) throw new Error('IM 记忆文件超过读取上限')
      return await file.handle.readFile({ encoding: 'utf8' })
    } finally { await file.handle.close() }
  }

  return {
    ownerId, initialize, flush,
    async clear() {
      for (const [target, name] of Object.entries(desktopMemoryFiles)) {
        const empty = ['profile', 'pattern', 'facts'].includes(target) ? '[]' : name.endsWith('.json') ? '{}' : ''
        await clearFile(name, empty)
      }
      const pending = vectorWrites.then(() => clearFile(vectorCacheName, '{}'))
      vectorWrites = pending.catch(() => {})
      await pending
    },
    async readMemoryVectors(keys: readonly string[]) {
      const raw = await readVectorCache()
      return new Map(keys.flatMap(key => {
        const vector = raw[key]
        return Array.isArray(vector) && vector.length > 0
          && vector.every(value => typeof value === 'number' && Number.isFinite(value))
          ? [[key, vector as number[]] as const] : []
      }))
    },
    writeMemoryVector(key: string, vector: readonly number[]) {
      const pending = vectorWrites.then(async () => {
        const entries = Object.entries(await readVectorCache()).filter(([id]) => id !== key)
        entries.push([key, vector])
        const retained = entries.slice(-128)
        let body = JSON.stringify(Object.fromEntries(retained))
        while (Buffer.byteLength(body) > 1_000_000 && retained.length) {
          retained.shift()
          body = JSON.stringify(Object.fromEntries(retained))
        }
        await publish(vectorCacheName, body)
      })
      vectorWrites = pending.catch(() => {})
      return pending
    },
    async readAll() {
      const entries = await Promise.all(Object.entries(desktopMemoryFiles).map(async ([target, name]) => [target, await read(name)] as const))
      return Object.fromEntries(entries.filter((entry): entry is [typeof entry[0], string] => entry[1] !== undefined))
    },
    async readTarget(target: string) {
      const name = filename(target)
      return name ? read(name) : undefined
    },
    readImScope, flushImportedIm,
    writeImScope: publishImScope,
  }
}

export type DesktopMemoryFiles = ReturnType<typeof createDesktopMemoryFiles>
