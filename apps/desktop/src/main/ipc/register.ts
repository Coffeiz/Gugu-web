import { DESKTOP_CHANNELS, type DesktopAgentChatEvent } from '@gugu/core/desktop'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { desktopReply } from '../core-host.js'
import type { IpcHandlers } from './types.js'

interface Registration {
  authorize(event: IpcMainInvokeEvent, channel: string, args: readonly unknown[]): boolean | Promise<boolean>
  onResult(event: IpcMainInvokeEvent, channel: string, result: unknown): void
}

export function registerDesktopIpc(ipc: Pick<IpcMain, 'handle'>, handlers: IpcHandlers, options: Registration): void {
  for (const [channel, action] of Object.entries(handlers))
    ipc.handle(channel, (event, ...args: unknown[]) =>
      desktopReply(options.authorize(event, channel, args), async () => {
        const command = args[0] as { action?: unknown; progressId?: unknown } | undefined
        const progressId = command?.progressId
        const result = channel === DESKTOP_CHANNELS.files && command?.action === 'move-dropped' && typeof progressId === 'string'
          ? await action(command, (percent: number) => {
              if (!event.sender.isDestroyed()) event.sender.send(DESKTOP_CHANNELS.droppedFileProgress, progressId, percent)
            })
          : channel === DESKTOP_CHANNELS.agentSessions && (command?.action === 'send' || command?.action === 'resume')
            ? await action(command, (update: DesktopAgentChatEvent) => {
                if (!event.sender.isDestroyed()) event.sender.send(DESKTOP_CHANNELS.agentChatEvent, update)
              })
            : await action(...args)
        options.onResult(event, channel, result)
        return result
      }),
    )
}
