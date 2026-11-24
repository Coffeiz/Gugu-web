import { createLocalFileTree } from '@gugu/fs/node'
import { createHash } from 'node:crypto'
import type { ToolCall } from '../models.js'
import type { ToolScope } from './contracts.js'


export const agentDownloadsLimit = 64 * 1024 * 1024

export async function saveAgentDownload(
  storageRoot: string, directoryKey: string, name: string, data: AsyncIterable<Uint8Array>, scope: ToolScope, call: ToolCall,
  authorize: () => Promise<boolean>,
  logicalDirectory = '/personal/download',
  createDirectory = true,
) {
  const tree = createLocalFileTree(storageRoot, directoryKey)
  return saveAgentDownloadTo(name, data, scope, call, authorize, async (filename, stream, signal) => {
    if (createDirectory && !await tree.ensureRoot()) throw new Error('下载目录不可用')
    await tree.upload(filename, stream, signal)
  }, logicalDirectory)
}

/** 共用文件名、容量和授权检查，Host 负责安全地提交文件。 */
export async function saveAgentDownloadTo(
  name: string, data: AsyncIterable<Uint8Array>, scope: ToolScope, call: ToolCall,
  authorize: () => Promise<boolean>,
  write: (filename: string, data: AsyncIterable<Uint8Array>, signal: AbortSignal) => Promise<void>,
  logicalDirectory = '/personal/download',
) {
  const { identity, signal } = scope
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
  await write(filename, (async function* () {
    for await (const chunk of data) {
      size += chunk.byteLength
      if (size > agentDownloadsLimit) throw new Error('文件超过 64 MiB')
      yield chunk
    }
    await check()
  })(), signal)
  return { kind: 'completed', successful: true, mutated: true, value: {
    success: true, name: filename, path: `${logicalDirectory}/${filename}`, size_bytes: size,
  } } as const
}
