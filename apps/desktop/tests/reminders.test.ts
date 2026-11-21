import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { IpcHost } from '../src/main/ipc/types.js'
import { scheduleHandlers } from '../src/main/schedules/ipc.js'
import { deliverLocalReminder } from '../src/main/schedules/reminders.js'

const notification = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Notification: class extends EventEmitter {
      static isSupported() { return true }
      show() { notification.show(this) }
    },
  }
})

const task = { id: 1, name: '合成提醒', payload: '合成内容', execution_mode: 'reminder', channels: ['web'] }
const host = { request: vi.fn(async () => task) } as unknown as IpcHost
const run = () => scheduleHandlers(host, deliverLocalReminder)[DESKTOP_CHANNELS.scheduleTask]!({ action: 'run', id: 1 })

afterEach(() => {
  vi.useRealTimers()
  notification.show.mockReset()
})

it('手动运行等待系统显示事件后才返回已发送', async () => {
  let shown: EventEmitter | undefined
  notification.show.mockImplementation(value => { shown = value })
  let complete = false
  const result = run().then(value => { complete = true; return value })
  await vi.waitFor(() => expect(shown).toBeDefined())
  expect(complete).toBe(false)
  shown!.emit('show', {})
  await expect(result).resolves.toEqual({ msg: '已发送桌面提醒' })
})

it('macOS 拒绝通知时返回可操作的错误，关闭后续事件监听', async () => {
  notification.show.mockImplementation((value: EventEmitter) => {
    value.emit('failed', {}, '未能完成操作。（UNErrorDomain错误1。）')
    expect(value.listenerCount('show')).toBe(0)
  })
  await expect(run()).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('系统通知设置') })
})

it('系统未返回投递事件时报未确认，迟到的事件不改变结果', async () => {
  vi.useFakeTimers()
  const result = run()
  const checked = expect(result).rejects.toMatchObject({ code: 'notification_unconfirmed' })
  await vi.advanceTimersByTimeAsync(5_000)
  await checked
  const emitter = notification.show.mock.calls[0]![0] as EventEmitter
  expect(emitter.listenerCount('show')).toBe(0)
  expect(emitter.listenerCount('failed')).toBe(0)
})
