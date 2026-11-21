import type { CreateLocalPty } from '@/views/Terminals/localPtyAccess'
import { requestDesktopTerminal } from '../bridge/bridge'
import type { DesktopTerminalAction } from '@gugu/core/desktop'

type Size = { cols: number; rows: number }
let queue = Promise.resolve()

export const createDesktopPtyTransport: CreateLocalPty = (terminalId, callbacks) => {
  let closed = false
  let started = false
  let closing: Promise<void> | undefined
  let timer: number | undefined

  function request(command: DesktopTerminalAction) {
    const result = queue.then(async () => {
      if (closed && command.action !== 'close') return
      if (command.action === 'open') started = true
      if (command.action === 'close' && !started) return
      const response = await requestDesktopTerminal({ ...command, terminalId })
      if (closed) return
      if (response.output) callbacks.output(response.output)
      if (response.exited) {
        closed = true
        window.clearTimeout(timer)
        callbacks.exit()
      } else if (command.action === 'open') {
        callbacks.ready()
      }
    }).catch(error => {
      if (closed) return
      window.clearTimeout(timer)
      callbacks.error(error)
      void close()
    })
    queue = result
    return result
  }

  async function poll() {
    if (closed) return
    await request({ action: 'output' })
    if (!closed) timer = window.setTimeout(poll, callbacks.foreground() ? 160 : 500)
  }

  function close() {
    closed = true
    window.clearTimeout(timer)
    return closing ??= request({ action: 'close' })
  }

  function size(value: Size): Size {
    return { cols: Math.max(20, Math.min(500, value.cols)), rows: Math.max(5, Math.min(200, value.rows)) }
  }

  return {
    async open(value: Size) {
      await request({ action: 'open', ...size(value) })
      void poll()
    },
    resize(value: Size) { void request({ action: 'resize', ...size(value) }) },
    input(data: string) {
      const points = Array.from(data)
      for (let offset = 0; offset < points.length; offset += 2048)
        void request({ action: 'input', data: points.slice(offset, offset + 2048).join('') })
    },
    close,
  }
}
