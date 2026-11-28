import { setTimeout as delay } from 'node:timers/promises'
import { DESKTOP_CHANNELS, type DesktopScheduledTask } from '@gugu/core/desktop'
import { DesktopError } from '../core-host.js'
import type { IpcHost, IpcHandlers } from '../ipc/types.js'

export type Reminder = Pick<DesktopScheduledTask, 'id' | 'name' | 'payload'>
type Deliver = (task: Reminder) => Promise<string>

export async function runScheduledInstruction(host: IpcHost, id: number, fireAt?: number, signal?: AbortSignal) {
  await host.request('schedules.instruction.start', { id, ...(fireAt === undefined ? {} : { fireAt }) })
  for (;;) {
    await delay(500, undefined, { signal })
    const result = await host.request<{ text: string; status: 'success' | 'failed' } | null>('schedules.instruction.result', { id })
    if (!result) continue
    if (result.status === 'failed') throw new DesktopError('schedule_failed', result.text)
    return result.text
  }
}

export function scheduleHandlers(host: IpcHost, deliver: Deliver, canDeliverInstructions = true): IpcHandlers {
  return {
    [DESKTOP_CHANNELS.scheduleTask]: async command => {
      if (!command || typeof command !== 'object' || !('action' in command))
        throw new DesktopError('invalid_request', '定时任务操作无效')
      const event = 'eventId' in command ? { eventId: command.eventId } : {}
      switch (command.action) {
        case 'channels': return host.request('schedules.channels')
        case 'targets': return host.request('schedules.targets', { platform: 'platform' in command ? command.platform : null })
        case 'list': return host.request('schedules.list', { ...event, ...('before' in command ? { before: command.before } : {}) })
        case 'create': return host.request('schedules.create', { ...event, fields: 'fields' in command ? command.fields : null })
        case 'update': return host.request('schedules.update', {
          ...event, id: 'id' in command ? command.id : null, fields: 'fields' in command ? command.fields : null,
        })
        case 'delete': return host.request('schedules.delete', { ...event, id: 'id' in command ? command.id : null })
        case 'run': {
          const task = await host.request('schedules.get', { id: 'id' in command ? command.id : null }) as DesktopScheduledTask
          if (task.execution_mode === 'instruction') {
            const text = await runScheduledInstruction(host, task.id)
            const msg = canDeliverInstructions && task.channels.includes('web')
              ? await deliver({ ...task, payload: text }) : task.channels.some(channel => channel !== 'web') ? '已发送 IM 结果' : text
            return { msg }
          }
          if (task.channels.some(channel => channel !== 'web')) {
            const msg = await host.request<string>('schedules.reminder.deliverIm', { id: task.id })
            if (task.channels.includes('web')) await deliver(task)
            return { msg }
          }
          if (!task.channels.includes('web')) throw new DesktopError('invalid_request', '请先开启桌面系统通知')
          return { msg: await deliver(task) }
        }
        default: throw new DesktopError('invalid_request', '定时任务操作无效')
      }
    },
  }
}
