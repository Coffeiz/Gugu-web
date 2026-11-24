import { openAnchoredLocalFile } from '@gugu/fs/node'
import { posix } from 'node:path'
import { createViewImageTool as createCoreViewImageTool, withViewImageReferences } from '@gugu/core/agent'
import type { ProviderHttpResponse } from '@gugu/core/providers'
import type { RunIdentity } from '@gugu/core/agent'
import { readSessionToolAttachments } from './session-attachments.js'
import type { Pool } from 'pg'
import type { FileHandle } from 'node:fs/promises'
import type { ShellMountPlan } from '../../../terminals/sandbox/bubblewrap.js'

export { withViewImageReferences }

/** Web 只负责会话沙箱路径和安全公网出口；图片校验、工具定义与引用生命周期复用 Core。 */
export function createViewImageTool(options: {
  authorize(identity: RunIdentity, signal: AbortSignal): Promise<boolean>
  supportsImage(identity: RunIdentity, signal: AbortSignal): Promise<boolean>
  mount(identity: RunIdentity, signal: AbortSignal): Promise<ShellMountPlan | null>
  attachments?: { pool: Pick<Pool, 'query'>; download(ownerId: string, attachId: string): Promise<{ handle: FileHandle }> }
  open(url: string, signal: AbortSignal): Promise<ProviderHttpResponse>
}) {
  const attachments = options.attachments
  return createCoreViewImageTool({
    authorize: options.authorize,
    supportsImage: options.supportsImage,
    async openPath(identity, requested, signal) {
      if (requested.includes('\\') || requested.includes('\0') || requested.split('/').includes('..')) return null
      const mount = await options.mount(identity, signal)
      if (!mount) return null
      const path = posix.resolve(mount.sandboxCwd, requested)
      const entry = [...mount.sandboxMounts].sort((a, b) => b.target.length - a.target.length)
        .find(item => path === item.target || path.startsWith(item.target + '/'))
      let image: Awaited<ReturnType<typeof openAnchoredLocalFile>> = null
      try {
        if (entry?.descriptor !== undefined && path !== entry.target)
          image = await openAnchoredLocalFile(entry.descriptor, path.slice(entry.target.length + 1))
      } finally {
        try { await mount.close() }
        catch (error) { await image?.handle.close(); throw error }
      }
      return image
    },
    ...(attachments ? { openAttachment: async (identity, attachId, signal) => {
      const [row] = await readSessionToolAttachments(attachments.pool, identity, [attachId], true)
      signal.throwIfAborted()
      if (row?.kind !== 'image' || !await options.authorize(identity, signal)) return null
      const { handle } = await attachments.download(identity.ownerId, attachId)
      try {
        const stats = await handle.stat()
        if (stats.isFile() && stats.size === Number(row.size) && !signal.aborted) return { handle, size: stats.size }
      } catch (error) {
        await handle.close()
        throw error
      }
      await handle.close()
      return null
    } } : {}),
    open: options.open,
  })
}
