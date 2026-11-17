import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'

/** Linux 目录逐层以 NOFOLLOW 打开，返回的句柄必须保持到子进程退出。 */
export async function pinTerminalDirectory(root: string, owner: string, key: string) {
  const segments = key.split('/')
  if (process.platform !== 'linux' || !/^[0-9a-f-]{36}$/i.test(owner) || segments[0] !== owner || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')))
    throw new Error('终端目录无效')
  const handles: FileHandle[] = []
  try {
    let handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    handles.push(handle)
    for (const segment of segments) {
      handle = await open(`/proc/self/fd/${handle.fd}/${segment}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      handles.push(handle)
    }
    let closed = false
    return { path: `/proc/${process.pid}/fd/${handle.fd}`, async close() {
      if (closed) return
      closed = true
      for (const item of handles.reverse()) await item.close()
    } }
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close().catch(() => {})
    throw error
  }
}
