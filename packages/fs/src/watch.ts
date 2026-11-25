import { watch } from 'node:fs'
import { Readable } from 'node:stream'

let activeWatches = 0

/** 只发送失效通知，路径和文件名留在宿主。 */
export function watchDirectoryChanges(directory: string, release?: () => void, authorized?: () => Promise<boolean>): Readable {
  if (activeWatches >= 256) throw new Error('文件监听连接已满')
  const stream = new Readable({ read() {} })
  let timer: ReturnType<typeof setTimeout> | undefined
  let checking = false
  let changed = false

  async function notify() {
    if (checking || stream.destroyed || !changed) return
    checking = true
    changed = false
    try {
      if (authorized && !await authorized()) stream.destroy()
      else if (!stream.destroyed && !stream.readableLength) stream.push('1\n')
    } catch { stream.destroy() }
    finally {
      checking = false
      if (changed && !stream.destroyed) schedule()
    }
  }

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(() => { void notify() }, 120)
  }

  const watcher = watch(directory, { persistent: false }, () => {
    changed = true
    schedule()
  })
  activeWatches++
  watcher.once('error', () => stream.destroy())
  watcher.once('close', () => stream.destroy())
  stream.once('close', () => {
    activeWatches--
    clearTimeout(timer)
    watcher.close()
    release?.()
  })
  stream.push('1\n')
  return stream
}
