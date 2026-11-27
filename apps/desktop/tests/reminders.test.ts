import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { IpcHost } from '../src/main/ipc/types.js'
import { createDesktopScheduledIm } from '../src/main/schedules/im.js'
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

it('预览中手动试跑指令返回 Agent 正文，并且不发送系统通知', async () => {
  vi.useFakeTimers()
  const request = vi.fn(async (method: string) => {
    if (method === 'schedules.get') return { ...task, execution_mode: 'instruction' }
    if (method === 'schedules.instruction.start') return null
    if (method === 'schedules.instruction.result') return { status: 'success', text: '合成执行结果' }
    throw new Error('未预期的任务请求')
  })
  const handlers = scheduleHandlers({ request } as unknown as IpcHost, deliverLocalReminder, false)
  const result = handlers[DESKTOP_CHANNELS.scheduleTask]!({ action: 'run', id: task.id })
  await vi.advanceTimersByTimeAsync(500)
  await expect(result).resolves.toEqual({ msg: '合成执行结果' })
  expect(request).toHaveBeenCalledWith('schedules.instruction.start', { id: task.id })
  expect(notification.show).not.toHaveBeenCalled()
})

it('主动群提醒使用已绑定的 Bot，取凭据后撤权则不发送', async () => {
  const target = { platform: 'qq', chatType: 'group', recipient: 'group-synthetic',
    botId: 'bot-synthetic', boundUserId: 'owner-synthetic' }
  const bot = { appId: target.botId, appSecret: 'synthetic-secret', userId: target.boundUserId,
    enabled: true, groupChatEnabled: true }
  const paths: string[] = []
  let revokeAfterAuthorization = false
  const delivery = createDesktopScheduledIm({
    qq: async () => bot,
    feishu: async () => null,
    telegram: async () => null,
    wechat: async () => null,
    transport: () => ({
      async request(request) {
        const path = new URL(request.url).pathname
        paths.push(path)
        const isToken = path.endsWith('/getAppAccessToken')
        if (isToken && revokeAfterAuthorization) bot.groupChatEnabled = false
        return { status: 200, headers: {}, body: (async function* () {
          yield Buffer.from(JSON.stringify(isToken ? { access_token: 'synthetic-access' } : { id: 'synthetic-send' }))
        })(), cancel() {} }
      },
      async close() {},
    }),
  })
  const signal = new AbortController().signal
  await expect(delivery.deliver({ ...target, boundUserId: 'other-synthetic' }, '提醒正文', signal))
    .rejects.toMatchObject({ code: 'conflict' })
  expect(paths).toEqual([])
  revokeAfterAuthorization = true
  await expect(delivery.deliver(target, '提醒正文', signal)).rejects.toMatchObject({ code: 'schedule_failed' })
  expect(paths).toEqual(['/app/getAppAccessToken'])
})

it('定时任务表单请求桌面渠道，并把所选微信和 QQ 交给任务保存接口', async () => {
  const fields = { name: '合成提醒', payload: '合成内容', channels: ['wechat', 'qq'] }
  const request = vi.fn(async (method: string) => {
    if (method === 'schedules.channels') return { channels: ['wechat', 'qq'] }
    if (method === 'schedules.create') return { id: 1 }
    throw new Error('未预期的任务请求')
  })
  const handle = scheduleHandlers({ request } as unknown as IpcHost, deliverLocalReminder)[DESKTOP_CHANNELS.scheduleTask]!
  await expect(handle({ action: 'channels' })).resolves.toEqual({ channels: ['wechat', 'qq'] })
  await expect(handle({ action: 'create', fields })).resolves.toEqual({ id: 1 })
  expect(request).toHaveBeenCalledWith('schedules.create', { fields })
})

it('私聊定时任务使用当前 QQ 绑定，发送中换绑时停止投递', async () => {
  const target = { platform: 'qq', chatType: 'c2c' }
  let bot = { appId: 'new-bot', appSecret: 'synthetic-secret', userId: 'new-owner', enabled: true, privateMessageFormat: 'markdown' as 'markdown' | 'compat' }
  let changeAfterToken = false
  const requests: string[] = []
  const messageTypes: number[] = []
  const sender = createDesktopScheduledIm({
    qq: async () => bot,
    feishu: async () => null,
    telegram: async () => null,
    wechat: async () => null,
    transport: () => ({
      async request(request) {
        const path = new URL(request.url).pathname
        requests.push(path)
        const isToken = path.endsWith('/getAppAccessToken')
        if (!isToken) messageTypes.push(JSON.parse(String(request.body)).msg_type)
        if (isToken && changeAfterToken) bot = { ...bot, appId: 'other-bot', userId: 'other-owner' }
        return { status: 200, headers: {}, body: (async function* () {
          yield Buffer.from(JSON.stringify(isToken ? { access_token: 'synthetic-access' } : { id: 'synthetic-send' }))
        })(), cancel() {} }
      },
      async close() {},
    }),
  })
  const signal = new AbortController().signal
  await sender.deliver(target, '合成提醒', signal)
  expect(requests).toEqual(['/app/getAppAccessToken', '/v2/users/new-owner/messages'])
  bot.privateMessageFormat = 'compat'
  await sender.deliver(target, '合成兼容提醒', signal)
  expect(messageTypes).toEqual([2, 0])
  changeAfterToken = true
  await expect(sender.deliver(target, '合成提醒', signal)).rejects.toMatchObject({ code: 'schedule_failed' })
  expect(requests.slice(4)).toEqual(['/app/getAppAccessToken'])
})
