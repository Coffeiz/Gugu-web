import { randomBytes } from 'node:crypto'
import { dataContext } from '@gugu/core/contracts'
import type { StoredMemoryVector, UserMemoryVectorKind } from '@gugu/core/byok/vector-rebuild'
import { openLocalFile, UnsafeLocalPathError, writeLocalFile } from '@gugu/fs/node'

const maxBytes = 50_000_000
const vectorPath: Record<UserMemoryVectorKind, string> = {
  pattern: '.agent/pattern_vec.json',
  memory: '.agent/memory_vec.json',
}

async function readText(root: string, ownerId: string, relativePath: string): Promise<string | null> {
  const file = await openLocalFile(root, `${ownerId}/${relativePath}`)
  if (!file) return null
  try {
    if (file.size > maxBytes) throw new Error('记忆文件超过读取上限')
    const text = await file.handle.readFile({ encoding: 'utf8' })
    if (Buffer.byteLength(text) > maxBytes) throw new Error('记忆文件超过读取上限')
    return text
  } finally { await file.handle.close() }
}

function parseJson(text: string | null): unknown {
  if (!text?.trim()) return null
  try { return JSON.parse(text) } catch { return null }
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 文件系统适配器；owner、相对路径和原子替换均由可信 Host 固定。 */
export function createLocalUserMemoryVectorStore(root: string) {
  return {
    async readPatterns(rawOwnerId: string): Promise<unknown> {
      const ownerId = dataContext(rawOwnerId).ownerId
      const current = await readText(root, ownerId, '.agent/pattern.json')
      if (current !== null) {
        if (current.trim()) {
          const parsed = parseJson(current)
          if (Array.isArray(parsed)) return parsed.filter(value => object(value) && typeof value.text === 'string' && value.text.trim())
        } else {
          // Python 把显式清空留下的空文件规范化为空列表，并清掉对应向量缓存。
          const vectors = parseJson(await readText(root, ownerId, vectorPath.pattern))
          if (object(vectors) && Object.keys(vectors).length)
            await writeLocalFile(root, `${ownerId}/${vectorPath.pattern}`, '{}')
          return []
        }
      }

      const legacyJson = await readText(root, ownerId, '.agent/facts.json')
      const legacy = parseJson(legacyJson)
      if (Array.isArray(legacy)) {
        const patterns = legacy.filter(value => object(value) && typeof value.text === 'string' && value.text.trim())
        if (patterns.length) await writeLocalFile(root, `${ownerId}/.agent/pattern.json`, JSON.stringify(patterns, null, 2))
        return patterns
      }
      const legacyMarkdown = (await readText(root, ownerId, '.agent/facts.md') || '').trim()
      if (!legacyMarkdown) return []
      const timestamp = Date.now() / 1000
      const patterns = legacyMarkdown.split(/\r?\n/u).flatMap(line => {
        const text = line.trim().replace(/^-+/u, '').trim()
        return text ? [{ id: randomBytes(3).toString('hex'), text, kind: 'observed', conf: 0.75, imp: 3, ts: timestamp }] : []
      })
      if (patterns.length) await writeLocalFile(root, `${ownerId}/.agent/pattern.json`, JSON.stringify(patterns, null, 2))
      return patterns
    },
    async readMemory(rawOwnerId: string): Promise<string | null> {
      return readText(root, dataContext(rawOwnerId).ownerId, '.agent/memory.md')
    },
    async readVectors(rawOwnerId: string, kind: UserMemoryVectorKind): Promise<unknown> {
      const raw = await readText(root, dataContext(rawOwnerId).ownerId, vectorPath[kind])
      const parsed = parseJson(raw)
      return object(parsed) ? parsed : {}
    },
    async writeVectors(rawOwnerId: string, kind: UserMemoryVectorKind, vectors: Record<string, StoredMemoryVector>): Promise<void> {
      await writeLocalFile(root, `${dataContext(rawOwnerId).ownerId}/${vectorPath[kind]}`, JSON.stringify(vectors, null, 2))
    },
    isUnsafePath(error: unknown): boolean { return error instanceof UnsafeLocalPathError },
  }
}
