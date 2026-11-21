import { selectImTextChoice, type ImPreflightScope, type ImTextChoicePrompt, type ImTextChoiceResult } from '@gugu/gateway'
import type { AgentInteractionRespondService } from '../../../agent/interactions/respond.js'

export interface ScopedImTextPrompt extends ImTextChoicePrompt {
  readonly scope: Omit<ImPreflightScope, 'eventId'>
  readonly promptId: number
  readonly sessionId: number
}
function sameScope(left: ScopedImTextPrompt['scope'], right: ImPreflightScope): boolean {
  return left.ownerId === right.ownerId && left.botId === right.botId && left.platform === right.platform &&
    left.chatType === right.chatType && left.chatId === right.chatId && left.platformUserId === right.platformUserId
}

/** 只将已按 IM 作用域定位的选项交给现有一次性动作/恢复服务，不另造确认。 */
export function createImTextChoiceConsumer(options: {
  service: AgentInteractionRespondService
  /** 最近活动 choice/confirm 优先，然后可接收文本的 prompt；必须绑定完整 session scope。 */
  find(scope: ImPreflightScope, signal: AbortSignal, text?: string): Promise<readonly ScopedImTextPrompt[] | { readonly replayed: true }>
  /** 临执行再次检查可信 Bot/作用域和 prompt-session 绑定；不能只按 owner 查询。 */
  authorize(scope: ImPreflightScope, promptId: number, sessionId: number, signal: AbortSignal): Promise<boolean>
}) {
  if (!options.service.resumeText || typeof options.find !== 'function' || typeof options.authorize !== 'function')
    throw new TypeError('IM 文本交互服务未完整配置')
  return async (scope: ImPreflightScope, text: string, signal: AbortSignal): Promise<ImTextChoiceResult | null> => {
    signal.throwIfAborted()
    const prompts = await options.find(scope, signal, text)
    // 已提交动作而普通inbox收据尚未落地的重试；lookup必须按scope+event定位原消费。
    if ('replayed' in prompts) return { status: 'replay' }
    for (const prompt of prompts) {
      if (!sameScope(prompt.scope, scope) || !Number.isSafeInteger(prompt.promptId) || prompt.promptId <= 0 ||
        !Number.isSafeInteger(prompt.sessionId) || prompt.sessionId <= 0) throw new Error('IM 交互作用域无效')
      const choice = selectImTextChoice(prompt, text)
      if (!choice) continue
      signal.throwIfAborted()
      if (!await options.authorize(scope, prompt.promptId, prompt.sessionId, signal)) throw new Error('IM 交互授权已失效')
      const result = choice.action === 'option'
        ? await options.service.respond(scope.ownerId, prompt.promptId, choice.token, scope.eventId || undefined)
        : await options.service.resumeText!(scope.ownerId, prompt.promptId, text, scope.eventId || undefined)
      if (result.session_id !== prompt.sessionId || result.prompt_id !== prompt.promptId) throw new Error('IM 交互返回作用域无效')
      if (result.result.status === 'error') return { status: 'error' }
      return result.result.status === 'awaiting_text' ? { status: 'awaiting_text' }
        : { status: 'selected', ...(typeof result.result.text === 'string' ? { text: result.result.text } : {}) }
    }
    return null
  }
}
