import type { RunIdentity, ToolResult } from '../agent/models.js'
import type { ToolDefinition } from '../agent/tools/contracts.js'
import type { ImPlatform } from './access.js'

const emojis = Object.freeze({ agree: 'THUMBSUP', good: 'THUMBSUP', love: 'HEART', thanks: 'THANKS', laugh: 'LAUGH',
  wow: 'WOW', sad: 'CRY', thinking: 'THINKING', celebrate: 'PARTY', ok: 'OK', done: 'DONE' })
type Mood = keyof typeof emojis
export interface ImReactionPort {
  /** 重新解析当前可信运行绑定并复核授权；不能使用模型传入的Bot/消息/接收者。 */
  react(input: { identity: RunIdentity; roundId: string; toolCallId: string; emoji: string; signal: AbortSignal }): Promise<'accepted' | 'rejected' | 'unknown'>
  /** 只查询持久工具或投递收据，结果未知时不得再次发送reaction。 */
  recover(input: { identity: RunIdentity; roundId: string; toolCallId: string; emoji: string }): Promise<'accepted' | 'rejected' | 'unknown'>
}
function result(outcome: 'accepted' | 'rejected' | 'unknown', mood: Mood, recovered = false): ToolResult {
  if (outcome === 'unknown') return { kind: 'unknown' }
  return { kind: 'completed', successful: outcome === 'accepted', mutated: outcome === 'accepted' && !recovered, executed: !recovered,
    value: outcome === 'accepted' ? { ok: true, message: `已给用户这条消息加了「${mood}」表情。` }
      : { ok: false, message: '加表情没成功（可能缺 im:message_reaction 权限），跳过即可，别重试。' } }
}

/** 每轮可信平台决定注册集合；非飞书连Schema也不注册，不能只在执行时拒绝。 */
export function createImReactionTools(platform: ImPlatform, port?: ImReactionPort): readonly ToolDefinition[] {
  if (platform !== 'feishu') return []
  if (!port || typeof port.react !== 'function' || typeof port.recover !== 'function') throw new TypeError('飞书reaction能力未配置')
  return [{
    definition: { name: 'react', schema: { type: 'function', function: { name: 'react', description: '仅飞书 IM 可用；给用户消息添加一次合适的表情回应。',
      parameters: { type: 'object', properties: { mood: { type: 'string', enum: Object.keys(emojis) } }, required: ['mood'] } } } },
    effect: 'write',
    validate(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return { success: false }
      const mood = 'mood' in input && typeof input.mood === 'string' ? input.mood.trim().toLowerCase() : ''
      return Object.hasOwn(emojis, mood) ? { success: true, data: { mood } } : { success: false }
    },
    async execute(input, scope, call) {
      const mood = (input as { mood: Mood }).mood
      const outcome = await port.react({ identity: scope.identity, roundId: scope.roundId, toolCallId: call.id,
        emoji: emojis[mood], signal: scope.signal })
      if (!['accepted', 'rejected', 'unknown'].includes(outcome)) return { kind: 'unknown' }
      return result(outcome, mood)
    },
    async reconcile(input, identity, call) {
      const mood = (input as { mood: Mood }).mood
      const outcome = await port.recover({ identity, roundId: identity.roundId, toolCallId: call.id, emoji: emojis[mood] })
      if (!['accepted', 'rejected', 'unknown'].includes(outcome)) return { kind: 'unknown' }
      return result(outcome, mood, true)
    },
  }]
}
