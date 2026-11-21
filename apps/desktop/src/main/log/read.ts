import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { DesktopError } from '../core-host.js'
import type { IpcHandlers } from '../ipc/types.js'

const files = { regular: 'gugu.log', diagnostic: 'gugu-diag.log' } as const
const maxBytes = 96 * 1024
const maxLines = 300

export function desktopLogHandlers(userData: string): IpcHandlers {
  return {
    [DESKTOP_CHANNELS.readLogs]: async kind => {
      if (kind !== 'regular' && kind !== 'diagnostic')
        throw new DesktopError('invalid_request', '日志类型无效')
      const handle = await open(join(userData, 'logs', files[kind]), 'r').catch(error => {
        if (error?.code === 'ENOENT') return null
        throw error
      })
      if (!handle) return { lines: [], truncated: false }
      try {
        const { size } = await handle.stat()
        const start = Math.max(0, size - maxBytes)
        const buffer = Buffer.alloc(size - start)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
        const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/u)
        if (start > 0) lines.shift()
        // 写入中的最后一条记录会在下一次刷新时读到。
        lines.pop()
        return { lines: lines.filter(Boolean).slice(-maxLines), truncated: start > 0 || lines.length > maxLines }
      } finally {
        await handle.close()
      }
    },
  }
}
