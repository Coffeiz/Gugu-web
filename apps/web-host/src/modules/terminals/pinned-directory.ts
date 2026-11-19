import { constants } from 'node:fs'
import { mkdir, open, type FileHandle } from 'node:fs/promises'

/** Linux 目录逐层以 NOFOLLOW 打开，返回的句柄必须保持到子进程退出。 */
export async function pinTerminalDirectory(root: string, owner: string, key: string, initialize = false) {
  const segments = key.split('/')
  if (process.platform !== 'linux' || !/^[0-9a-f-]{36}$/i.test(owner) || segments[0] !== owner || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')))
    throw new Error('终端目录无效')
  const handles: FileHandle[] = []
  try {
    let handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    handles.push(handle)
    for (const segment of segments) {
      const path = `/proc/self/fd/${handle.fd}/${segment}`
      const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      try { handle = await open(path, flags) }
      catch (error) {
        if (!initialize || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // mkdir 与后续 open 锚定同一个父目录句柄，拒绝并发替换产生的符号链接。
        try { await mkdir(path, { mode: 0o770 }) }
        catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError }
        handle = await open(path, flags)
      }
      handles.push(handle)
    }
    let closed = false
    return { fd: handle.fd, path: `/proc/${process.pid}/fd/${handle.fd}`, async close() {
      if (closed) return
      closed = true
      for (const item of handles.reverse()) await item.close()
    } }
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close().catch(() => {})
    throw error
  }
}
