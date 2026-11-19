import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { terminalUi } from '@/i18n/sections/terminal'
import InteractivePtyTerminal from '@/views/Terminals/components/InteractivePtyTerminal.vue'

vi.mock('xterm', () => ({ Terminal: class {
  cols = 80
  rows = 24
  buffer = { active: { length: 0 } }
  loadAddon() {}
  open() {}
  focus() {}
  onData() {}
  write() {}
  dispose() {}
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@/services/authSession', () => ({ handleUnauthorized: vi.fn() }))

class Socket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static readonly connections: Socket[] = []
  readyState = Socket.OPEN
  sent: unknown[] = []
  onmessage?: (event: { data: string }) => void
  onclose?: (event: { code: number }) => void
  constructor() { Socket.connections.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  receive(value: object) { this.onmessage?.({ data: JSON.stringify(value) }) }
  end(code: number) { this.readyState = Socket.CLOSED; this.onclose?.({ code }) }
  close() { this.end(1000) }
}

let cleanup: (() => void) | undefined
beforeEach(() => {
  Socket.connections.length = 0
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
})
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); vi.useRealTimers() })

function render() {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(InteractivePtyTerminal, { terminalId: 'synthetic-terminal' })
  app.use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': { terminalUi: terminalUi['zh-CN'] } } }))
  app.mount(host)
  cleanup = () => { app.unmount(); host.remove() }
  return host
}

it('握手后的启动错误保留具体原因并等待手动重试', async () => {
  const host = render()
  const socket = Socket.connections[0]!
  expect(socket.sent).toEqual([])
  socket.receive({ type: 'error', errorCode: 'pty_setup_failed', message: 'PTY 启动失败' })
  socket.end(4409)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(Socket.connections).toHaveLength(1)
  expect(host.querySelector('[role="status"]')?.textContent).toBe('PTY 启动失败')
  host.querySelector('button')?.click()
  expect(Socket.connections).toHaveLength(2)
  const resumed = Socket.connections[1]!
  resumed.receive({ type: 'ready' })
  await nextTick()
  expect(resumed.sent).toContainEqual({ type: 'resize', cols: 80, rows: 24 })
  expect(host.querySelector('[role="status"]')).toBeNull()
})

it('连接持续中断时自动重试次数有上限', async () => {
  const host = render()
  for (let attempt = 0; attempt <= 5; attempt++) {
    Socket.connections[attempt]!.end(1006)
    await vi.advanceTimersByTimeAsync(5100)
  }
  expect(Socket.connections).toHaveLength(6)
  expect(host.querySelector('button')?.textContent).toContain('重试连接')
})
