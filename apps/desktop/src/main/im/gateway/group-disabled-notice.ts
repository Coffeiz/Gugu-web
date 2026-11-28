import { createHash } from 'node:crypto'
import { mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { notifyGroupDisabled } from '@gugu/gateway'

export type DesktopGroupDisabledNotice = (
  scope: readonly [platform: 'qq' | 'feishu' | 'telegram', bot: string, owner: string, group: string, epoch: string | undefined],
  options: Omit<Parameters<typeof notifyGroupDisabled>[0], 'store'>,
) => Promise<void>

export function createDesktopGroupDisabledNotice(directory: string): DesktopGroupDisabledNotice {
  const root = join(directory, 'im-group-disabled-notices')
  return (scope, options) => notifyGroupDisabled({
    ...options,
    store: { async claim() {
      const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
      await mkdir(root, { recursive: true, mode: 0o700 })
      const path = join(root, key)
      const file = await open(path, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return
        throw error
      })
      if (!file) return
      try { await file.sync() } finally { await file.close() }
      return () => unlink(path)
    } },
  })
}
