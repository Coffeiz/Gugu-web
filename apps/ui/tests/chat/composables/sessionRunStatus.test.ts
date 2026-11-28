import { expect, it } from 'vitest'
import { acceptsSidebarRunStatus } from '@/components/common/gugu-chat/composables/sessionRunStatus'

it('新 Run 启动后，旧流迟到的状态不会覆盖侧栏动画', () => {
  const first = { runId: 'first', running: true }
  const second = { runId: 'second', running: true }
  expect(acceptsSidebarRunStatus(first, second, true)).toBe(true)
  expect(acceptsSidebarRunStatus(second, first, false)).toBe(false)
  expect(acceptsSidebarRunStatus(second, { ...first, running: false }, false)).toBe(false)
  expect(acceptsSidebarRunStatus(second, { ...second, running: false }, true)).toBe(true)
})

it('等待确认时停掉动画，恢复后同一 Run 可以继续显示运行中', () => {
  const running = { runId: 'same-run', running: true }
  const waiting = { ...running, running: false }
  expect(acceptsSidebarRunStatus(running, waiting, true)).toBe(true)
  expect(acceptsSidebarRunStatus(waiting, running, true)).toBe(true)
})
