import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { desktopReply } from '../core-host.js'
import type { IpcHandlers } from './types.js'

interface Registration {
  authorize(event: IpcMainInvokeEvent, channel: string, args: readonly unknown[]): boolean
  onResult(event: IpcMainInvokeEvent, channel: string, result: unknown): void
}

export function registerDesktopIpc(ipc: Pick<IpcMain, 'handle'>, handlers: IpcHandlers, options: Registration): void {
  for (const [channel, action] of Object.entries(handlers))
    ipc.handle(channel, (event, ...args: unknown[]) =>
      desktopReply(options.authorize(event, channel, args), async () => {
        const result = await action(...args)
        options.onResult(event, channel, result)
        return result
      }),
    )
}
