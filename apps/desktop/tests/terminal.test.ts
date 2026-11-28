import { expect, it, vi } from 'vitest'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { desktopTerminalHandlers } from '../src/main/terminal/ipc'

it('桌面终端使用可信个人目录，渲染端无法指定路径或额外参数', async () => {
  const request = vi.fn(async () => ({ output: '', exited: false }))
  const host = { request } as unknown as Parameters<typeof desktopTerminalHandlers>[0]
  const handler = desktopTerminalHandlers(host, async () => '/测试/personal')[DESKTOP_CHANNELS.terminal]!
  const terminalId = '11111111-2222-4333-8444-555555555555'
  await handler({ action: 'open', terminalId, root: '/测试/其他目录', projectRoot: '/测试/其他项目', command: '其他命令', cols: 80, rows: 24 })
  expect(request).toHaveBeenCalledExactlyOnceWith('desktop.terminal', {
    action: 'open', terminalId, cols: 80, rows: 24, root: '/测试/personal',
  })
  await expect(handler({ action: 'resize', terminalId, cols: 1, rows: 24 })).rejects.toMatchObject({ code: 'invalid_request' })
  expect(request).toHaveBeenCalledTimes(1)
})
