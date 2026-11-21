import { DESKTOP_CHANNELS, type DesktopScheduledTask } from '@gugu/core/desktop'
import { DesktopError } from '../core-host.js'
import type { IpcHost, IpcHandlers } from '../ipc/types.js'

export type Reminder = Pick<DesktopScheduledTask, 'id' | 'name' | 'payload'>
type Deliver = (task: Reminder) => Promise<string>

export function scheduleHandlers(host: IpcHost, deliver: Deliver): IpcHandlers {
  return {
    [DESKTOP_CHANNELS.scheduleTask]: async command => {
      if (!command || typeof command !== 'object' || !('action' in command))
        throw new DesktopError('invalid_request', '定时任务操作无效')
      const event = 'eventId' in command ? { eventId: command.eventId } : {}
      switch (command.action) {
        case 'list': return host.request('schedules.list', { ...event, ...('before' in command ? { before: command.before } : {}) })
        case 'create': return host.request('schedules.create', { ...event, fields: 'fields' in command ? command.fields : null })
        case 'update': return host.request('schedules.update', {
          ...event, id: 'id' in command ? command.id : null, fields: 'fields' in command ? command.fields : null,
        })
        case 'delete': return host.request('schedules.delete', { ...event, id: 'id' in command ? command.id : null })
        case 'run': {
          const task = await host.request('schedules.get', { id: 'id' in command ? command.id : null }) as DesktopScheduledTask
          if (task.execution_mode === 'instruction') throw new DesktopError('unsupported', '桌面端尚未接入指令执行')
          if (!task.channels.includes('web')) throw new DesktopError('invalid_request', '请先开启桌面系统通知')
          return { msg: await deliver(task) }
        }
        default: throw new DesktopError('invalid_request', '定时任务操作无效')
      }
    },
  }
}
