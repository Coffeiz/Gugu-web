import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { openLocalFile, UnsafeLocalPathError } from '@gugu/fs/node'
import type { AgentKnowledgeReadStore } from '@gugu/core/agent/knowledge/overview'

const OWNER = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ENTRY_ID = '[A-Za-z0-9_-]{1,128}'
const MAX_ENTRY_BYTES = 1_048_576

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function missing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
}

async function safeDirectory(rootPath: string, relativePath: string): Promise<string | null> {
  const segments = relativePath.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')))
    throw new UnsafeLocalPathError()
  try {
    const root = await realpath(rootPath)
    let target = root
    for (const segment of segments) {
      target = path.resolve(target, segment)
      if (!within(root, target)) throw new UnsafeLocalPathError()
      const info = await lstat(target)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new UnsafeLocalPathError()
      target = await realpath(target)
      if (!within(root, target)) throw new UnsafeLocalPathError()
    }
    return target
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
}

/** Web Host 知识文件读取器：owner 来自 Core Worker，FS 根来自可信 Host 配置。 */
export function createLocalAgentKnowledgeReadStore(storageRoot: string): AgentKnowledgeReadStore {
  if (!storageRoot.trim()) throw new TypeError('知识存储根目录未配置')
  return {
    async exists(key) {
      const match = new RegExp(`^(${OWNER})/\\.agent/knowledge/(?:\\.timestamps-iso-v1|entries/${ENTRY_ID}\\.md)$`, 'u').exec(key)
      if (!match) throw new UnsafeLocalPathError()
      const opened = await openLocalFile(storageRoot, key)
      if (!opened) return false
      await opened.handle.close()
      return true
    },
    async list(prefix, cursor, limit) {
      const match = new RegExp(`^(${OWNER})/\\.agent/knowledge/entries/$`, 'u').exec(prefix)
      if (!match || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000
        || (cursor !== null && !new RegExp(`^${ENTRY_ID}(?:\\.md)?$`, 'u').test(cursor))) throw new UnsafeLocalPathError()
      const relativeDirectory = `${match[1]}/.agent/knowledge/entries`
      const directory = await safeDirectory(storageRoot, relativeDirectory)
      if (!directory) return { keys: [], nextCursor: null }
      const entries = await readdir(directory, { withFileTypes: true })
      const names = entries.filter(entry => entry.isFile() && entry.name.endsWith('.md')
        && new RegExp(`^${ENTRY_ID}\\.md$`, 'u').test(entry.name)).map(entry => entry.name).sort()
      const after = names.filter(name => cursor === null || name > cursor)
      const page = after.slice(0, limit)
      return {
        keys: page.map(name => `${prefix}${name}`),
        nextCursor: after.length > limit ? page.at(-1) ?? null : null,
      }
    },
    async read(key) {
      if (!new RegExp(`^${OWNER}/\\.agent/knowledge/entries/${ENTRY_ID}\\.md$`, 'u').test(key)) throw new UnsafeLocalPathError()
      const opened = await openLocalFile(storageRoot, key)
      if (!opened) throw new Error('知识文件不存在')
      try {
        if (opened.size > MAX_ENTRY_BYTES) throw new Error('知识文件超出读取限制')
        return new Uint8Array(await opened.handle.readFile())
      } finally {
        await opened.handle.close()
      }
    },
  }
}
