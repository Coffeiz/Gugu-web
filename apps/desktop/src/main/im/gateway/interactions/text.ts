import { createImTextChoiceConsumer, type ImReceivedMessage } from '@gugu/gateway'
import type { IpcHost } from '../../../ipc/types.js'
import type { createDesktopAgentModelService } from '../../../agent/model.js'

export function consumeDesktopImText(host: IpcHost,
  model: Pick<ReturnType<typeof createDesktopAgentModelService>, 'resolveRunModel'>,
  event: ImReceivedMessage, connectionId: string, eventKey: string, authorize: () => Promise<boolean>) {
  const consume = createImTextChoiceConsumer({
    async find(scope) {
      const target = await host.request<{ sessionId: number; runId: string; promptId: number; replayed: number } | null>(
        'im.inbox.prompt', { action: 'lookup-text', platform: scope.platform, connectionId, eventKey })
      if (!target) return []
      if (target.replayed) return { replayed: true }
      // SQLite 已选定可接收文本的已授权提示，选项令牌由原生按钮单独持有。
      return [{ ...target, scope, kind: 'question', secret: false, allowTextInput: true, customInputActive: true, options: [] }]
    },
    authorize,
    async consumeText(prompt, text) {
      const { sessionId: id, runId, promptId } = prompt
      const modelId = await host.request<string | null>('agent.sessions.runModel', { id, runId })
      const config = await model.resolveRunModel(modelId ?? undefined)
      if (!await authorize()) throw new Error('IM 交互授权已失效')
      await host.request('agent.sessions.respond', { id, runId, promptId, eventId: eventKey, text, model: config })
      return { session_id: id, prompt_id: promptId, result: { status: 'answered' } }
    },
  })
  return consume({ ...event.scope, eventId: eventKey }, event.text, new AbortController().signal)
}
