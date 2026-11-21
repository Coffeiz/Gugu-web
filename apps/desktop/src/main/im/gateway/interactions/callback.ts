import { createHash } from 'node:crypto'
import { matchesImInteractionScope, readImReceivedInteraction, type ImConnectionIdentity } from '@gugu/gateway'
import type { IpcHost } from '../../../ipc/types.js'
import type { createDesktopAgentModelService } from '../../../agent/model.js'

export function createDesktopImCallback(host: IpcHost, model: Pick<ReturnType<typeof createDesktopAgentModelService>, 'resolveRunModel'>) {
  return async (connection: ImConnectionIdentity, connectionId: string, userId: string,
    data: Record<string, unknown>, authorize: () => Promise<boolean>): Promise<boolean> => {
    const event = readImReceivedInteraction(connection, connection.platform, data)
    const action = event.action
    if ((!action.messageId && connection.platform !== 'qq') || !matchesImInteractionScope(event, {
      ...connection, chatType: 'c2c', chatId: null, platformUserId: userId,
    }) || !await authorize()) return false
    const target = await host.request<{ sessionId: number; runId: string } | null>('im.inbox.prompt', {
      action: 'lookup', platform: connection.platform, connectionId, promptId: action.promptId, messageId: action.messageId,
    })
    if (!target) return false
    const { sessionId: id, runId } = target
    const modelId = await host.request<string | null>('agent.sessions.runModel', { id, runId })
    const config = await model.resolveRunModel(modelId ?? undefined)
    if (!await authorize()) return false
    const eventId = createHash('sha256').update(JSON.stringify([connectionId, action.eventId])).digest('hex')
    await host.request('agent.sessions.respond', { id, runId, eventId, promptId: action.promptId, token: action.token, model: config })
    return true
  }
}
