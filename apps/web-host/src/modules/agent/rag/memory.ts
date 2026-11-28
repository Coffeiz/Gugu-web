import { openLocalFile, UnsafeLocalPathError } from '@gugu/fs/node'
import type { MemoryRagStorageReader } from '@gugu/core/agent/rag'

const OWNER = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const COMPONENT = '(?:[A-Za-z0-9._~-]|%[0-9a-fA-F]{2})+'
const MAX_TEXT_CHARS = 50_000_000
const SAFE_KEYS = new RegExp(
  `^${OWNER}/\\.agent/(?:rag/memory/index\\.json|memories/(?:(?:profile|pattern|facts|summary|stance|lens)\\.json|(?:facts|summary)\\.md|summary\\.ts|memory\\.md|daily\\.md|(?:memory|pattern)_vec\\.json)|knowledge/vectors\\.json|memories/im/${COMPONENT}/${COMPONENT}/groups/${COMPONENT}/members\\.json|memories/im/${COMPONENT}/${COMPONENT}/(?:groups|platform-users)/${COMPONENT}/(?:profile|pattern|summary)\\.json|memories/im/${COMPONENT}/${COMPONENT}/(?:groups|platform-users)/${COMPONENT}/(?:daily|memory)\\.md)$`,
  'u',
)

/** Web Host 仅开放 RAG memory loader 所需的 owner namespace 文件，权限与存储根来自可信 Host。 */
export function createLocalAgentMemoryRagStore(storageRoot: string): MemoryRagStorageReader {
  if (!storageRoot.trim()) throw new TypeError('记忆存储根目录未配置')
  return {
    async readText({ ownerId, key, maxChars, signal }) {
      signal?.throwIfAborted()
      if (!new RegExp(`^${OWNER}$`, 'u').test(ownerId) || !SAFE_KEYS.test(key)
        || !key.startsWith(`${ownerId}/`) || !Number.isSafeInteger(maxChars)
        || maxChars < 1 || maxChars > MAX_TEXT_CHARS) throw new UnsafeLocalPathError()
      const opened = await openLocalFile(storageRoot, key)
      if (!opened) return null
      try {
        signal?.throwIfAborted()
        if (opened.size > maxChars * 4) throw new Error('RAG memory 文件超出读取限制')
        const text = new TextDecoder('utf-8').decode(await opened.handle.readFile(signal ? { signal } : undefined))
        signal?.throwIfAborted()
        return text.slice(0, maxChars)
      } finally {
        await opened.handle.close()
      }
    },
  }
}
