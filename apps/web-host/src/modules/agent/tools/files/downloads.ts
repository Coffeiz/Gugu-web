import { createLocalFileTree } from '@gugu/fs/node'
import { createHash } from 'node:crypto'
import { personalFileStorageKey } from '../../../workspaces/roots.js'
import type { ToolCall } from '@gugu/core/agent'
import type { ToolScope } from '@gugu/core/tools'

export const agentDownloadsLimit = 64 * 1024 * 1024

/** 工具主动保存共用个人文件下的磁盘目录；附件接收流程不调用此入口。 */
export async function saveAgentDownload(
  storageRoot: string, name: string, data: AsyncIterable<Uint8Array>, scope: ToolScope, call: ToolCall,
  authorize: () => Promise<boolean>,
) {
  const { identity, signal } = scope
  const tree = createLocalFileTree(storageRoot, `${personalFileStorageKey(identity.ownerId)}/下载`)
  const clean = Array.from(name.replace(/[\\/\x00-\x1f<>:"|?*]/gu, '_').trim().replace(/^\.+/u, '')).slice(0, 48).join('') || '下载文件'
  const dot = clean.lastIndexOf('.')
  const suffix = createHash('sha256').update(JSON.stringify([identity.sessionId, identity.runId, scope.roundId, call.id, call.input])).digest('hex').slice(0, 16)
  const filename = dot > 0 ? `${clean.slice(0, dot)}-${suffix}${clean.slice(dot)}` : `${clean}-${suffix}`
  let size = 0
  async function check() {
    signal.throwIfAborted()
    if (!await authorize()) throw new Error('文件保存授权已失效')
    signal.throwIfAborted()
  }
  await check()
  if (!await tree.ensureRoot()) throw new Error('下载目录不可用')
  await tree.upload(filename, (async function* () {
    for await (const chunk of data) {
      size += chunk.byteLength
      if (size > agentDownloadsLimit) throw new Error('文件超过 64 MiB')
      yield chunk
    }
    await check()
  })(), signal)
  return { kind: 'completed', successful: true, mutated: true, value: {
    success: true, name: filename, path: `/personal/下载/${filename}`, size_bytes: size,
  } } as const
}
