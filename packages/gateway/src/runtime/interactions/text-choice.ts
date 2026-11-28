import { canAcceptInteractionText } from '@gugu/core/agent'
import { casefoldSearchText } from '@gugu/search'
import { asciiDecimalDigits, isDecimalDigits } from '@gugu/core/shared/unicode-decimal'
import type { ImPreflightScope } from '../inbound/preflight.js'

export type ImTextChoiceResult = { readonly status: 'awaiting_text' | 'selected' | 'replay' | 'error' | 'question_next'; readonly text?: string }

export interface ImTextChoicePrompt {
  readonly kind: string
  readonly secret: boolean
  readonly allowTextInput: boolean
  readonly customInputActive: boolean
  /** 保留 schema 声明顺序；已消费选项仍占序号，但 token=null。 */
  readonly options: readonly { readonly id: string; readonly label: string; readonly token: string | null }[]
}
export function selectImTextChoice(prompt: ImTextChoicePrompt, text: string):
  { readonly action: 'option'; readonly token: string } | { readonly action: 'text' } | null {
  const value = text.trim()
  if (prompt.secret || !value) return null
  if (['choice', 'confirm'].includes(prompt.kind) && Array.from(value).length <= 200) {
    const index = isDecimalDigits(value) ? Number(asciiDecimalDigits(value)) : 0
    const folded = casefoldSearchText(value)
    const selected = (index >= 1 && index <= prompt.options.length ? prompt.options[index - 1] : undefined)
      ?? prompt.options.find(option => [option.id, option.label].some(label => casefoldSearchText(label.trim()) === folded))
    if (selected) return selected.token ? { action: 'option', token: selected.token } : null
  }
  return canAcceptInteractionText(prompt)
    ? { action: 'text' } : null
}


export interface ScopedImTextPrompt extends ImTextChoicePrompt {
  readonly scope: Omit<ImPreflightScope, 'eventId'>
  readonly questionIndex?: number
  readonly promptId: number
  readonly sessionId: number
  readonly runId?: string
}
function sameScope(left: ScopedImTextPrompt['scope'], right: ImPreflightScope): boolean {
  return left.ownerId === right.ownerId && left.botId === right.botId && left.platform === right.platform &&
    left.chatType === right.chatType && left.chatId === right.chatId && left.platformUserId === right.platformUserId
}

/** 只将已按 IM 作用域定位的选项交给现有一次性动作/恢复服务，不另造确认。 */
interface ImChoiceReceipt {
  session_id: number
  prompt_id: number
  result: { status?: unknown; text?: unknown }
}

export function createImTextChoiceConsumer(options: {
  service?: {
    respond?(ownerId: string, promptId: number, token: string, eventId?: string): Promise<ImChoiceReceipt>
    resumeText?(ownerId: string, promptId: number, text: string, eventId?: string, questionIndex?: number): Promise<ImChoiceReceipt>
  }
  consumeText?(prompt: ScopedImTextPrompt, text: string, scope: ImPreflightScope, signal: AbortSignal): Promise<ImChoiceReceipt>
  /** 最近活动 choice/confirm 优先，然后可接收文本的 prompt；必须绑定完整 session scope。 */
  find(scope: ImPreflightScope, signal: AbortSignal, text?: string): Promise<readonly ScopedImTextPrompt[] | { readonly replayed: true }>
  /** 临执行再次检查可信 Bot/作用域和 prompt-session 绑定；不能只按 owner 查询。 */
  authorize(scope: ImPreflightScope, promptId: number, sessionId: number, signal: AbortSignal): Promise<boolean>
}) {
  const { service, consumeText } = options
  if ((!service?.resumeText && !consumeText) || typeof options.find !== 'function' || typeof options.authorize !== 'function')
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
      if (!choice || (choice.action === 'option' && !service?.respond)) continue
      signal.throwIfAborted()
      if (!await options.authorize(scope, prompt.promptId, prompt.sessionId, signal)) throw new Error('IM 交互授权已失效')
      const result = choice.action === 'option'
        ? await service!.respond!(scope.ownerId, prompt.promptId, choice.token, scope.eventId || undefined)
        : consumeText ? await consumeText(prompt, text, scope, signal)
        : await service!.resumeText!(scope.ownerId, prompt.promptId, text, scope.eventId || undefined,
          ...(prompt.questionIndex === undefined ? [] : [prompt.questionIndex] as const))
      if (result.session_id !== prompt.sessionId || result.prompt_id !== prompt.promptId) throw new Error('IM 交互返回作用域无效')
      if (result.result.status === 'question_replay') return { status: 'replay' }
      if (result.result.status === 'question_next') return { status: 'question_next', text: String(result.result.text) }
      if (prompt.questionIndex !== undefined) {
        if (result.result.status === 'cancelled') return { status: 'question_next', text: '已取消问答。' }
        if (result.result.status === 'answered') return { status: 'question_next', text: '已提交全部答案，咕咕会继续处理。' }
      }
      if (result.result.status === 'error') return { status: 'error' }
      return result.result.status === 'awaiting_text' ? { status: 'awaiting_text' }
        : { status: 'selected', ...(typeof result.result.text === 'string' ? { text: result.result.text } : {}) }
    }
    return null
  }
}
