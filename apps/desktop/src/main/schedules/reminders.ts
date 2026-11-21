import { Notification } from 'electron'
import { DesktopError } from '../core-host.js'
import type { IpcHost } from '../ipc/types.js'
import type { Reminder } from './ipc.js'

export async function deliverLocalReminder(task: Reminder): Promise<string> {
  if (!Notification.isSupported())
    throw new DesktopError('unsupported', '当前系统不支持桌面通知')
  const notification = new Notification({ title: task.name, body: task.payload || '定时任务提醒' })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new DesktopError('notification_unconfirmed', '系统未确认桌面提醒是否已送达')), 5_000)
    function finish(error?: DesktopError) {
      clearTimeout(timer)
      notification.removeListener('show', shown)
      notification.removeListener('failed', failed)
      if (error) reject(error)
      else resolve('已发送桌面提醒')
    }
    function shown() { finish() }
    function failed(_event: Electron.Event, error: string) {
      const denied = /UNErrorDomain[^\d]*1(?!\d)/u.test(error)
      finish(denied
        ? new DesktopError('forbidden', 'macOS 未允许此应用发送通知，请检查系统通知设置')
        : new DesktopError('notification_failed', '系统未能发送桌面提醒'))
    }
    notification.once('show', shown)
    notification.once('failed', failed)
    try { notification.show() } catch {
      finish(new DesktopError('notification_failed', '系统未能发送桌面提醒'))
    }
  })
}

export function startLocalReminders(host: IpcHost, onChanged: () => void, onError: (error: unknown) => void) {
  if (!Notification.isSupported()) return () => {}
  let active = true
  let checking = false
  let reportedError = false
  async function check() {
    if (!active || checking) return
    checking = true
    try {
      const tasks = await host.request('schedules.claim') as Reminder[]
      if (tasks.length) onChanged()
      const deliveries = await Promise.allSettled(tasks.map(deliverLocalReminder))
      const failed = deliveries.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
      reportedError = false
    } catch (error) {
      if (active && !reportedError) onError(error)
      reportedError = true
    } finally {
      checking = false
    }
  }
  const timer = setInterval(() => { void check() }, 15_000)
  void check()
  return () => {
    active = false
    clearInterval(timer)
  }
}
