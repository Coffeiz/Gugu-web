import type { Pool } from 'pg'
import type { FilePresentationPort } from '@gugu/core/tools'
import { createMindFileReferences } from '../../../mind/file-references.js'
import type { AgentDispatchLease } from '../../run/dispatch.js'

/** 直接从当前用户的文件树签发路径引用。 */
export function createWebAgentFilePresentPort(options: {
  pool: Pool
  storageRoot: string
  ownerId: string
  lease: AgentDispatchLease
}): FilePresentationPort {
  const expected = Object.freeze({ ...options.lease.identity })
  if (options.lease.input.v !== 2 || options.lease.input.source !== 'web'
    || expected.ownerId !== options.ownerId) throw new TypeError('Web Agent 文件展示来源无法验证')
  const references = createMindFileReferences(options.pool, options.storageRoot)
  return {
    async resolve(identity, selector, signal) {
      signal.throwIfAborted()
      if (identity.ownerId !== expected.ownerId || identity.sessionId !== expected.sessionId || identity.runId !== expected.runId)
        return { error: '文件不存在' }
      const query = selector.file.trim()
      if (!query || query.startsWith('file://') || (query.startsWith('/') && !/^\/(?:personal|project|workspace)\//u.test(query)))
        return { error: '请使用文件库逻辑路径或文件名' }
      const matches = await references(expected.ownerId, query, 11, signal)
      signal.throwIfAborted()
      const exact = query.startsWith('/') ? matches : matches.filter(file => file.label === query)
      const candidates = exact.length ? exact : matches
      if (candidates.length !== 1)
        return { error: candidates.length ? '有多个匹配文件，请提供准确路径' : '未找到文件' }
      const { id, label } = candidates[0]!
      const dot = label.lastIndexOf('.')
      return { file: { referenceId: id, name: dot > 0 ? label.slice(0, dot) : label,
        ext: dot > 0 ? label.slice(dot + 1) : '', surface: 'browser' } }
    },
  }
}
