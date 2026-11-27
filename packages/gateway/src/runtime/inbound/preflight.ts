import type { ImTextChoiceResult } from '../interactions/text-choice.js'
import { parseImControlCommand } from '@gugu/core/im/shortcut'
import { handleQqBinding } from '../../platforms/qq/binding.js'
import { handleTelegramBinding } from '../../platforms/telegram/binding.js'
import type { ImConversationScope } from '../../ir/inbound.js'

/** owner/Bot 必须来自连接配置；chat/user/event 必须来自已验证的平台事件。 */
export interface ImPreflightScope extends ImConversationScope {
  readonly eventId: string
  /** 正式Gateway仅从永久准入收据的DB时刻注入；直接Host调用可显式不使用准入边界。 */
  readonly admissionCutoff?: string
}
export interface ImPreflightMessage {
  readonly scope: ImPreflightScope
  readonly text: string
  /** 当前、引用媒体及表情均计入；不能为通过文本检查而先下载。 */
  readonly hasPendingMedia: boolean
  readonly botMentioned: boolean
  /** 仅接受平台 parser 确认、且指向当前 Bot 的命令。 */
  readonly telegramCommand?: string | null
}
export type ImSecretStage = { readonly status: 'none' | 'replay' | 'ended' }
  | { readonly status: 'pending_choice' | 'awaiting_secret'; readonly reference: string }
export type ImSecretAction = { readonly action: 'start' } | { readonly action: 'cancel' }
  | { readonly action: 'value'; readonly value: string }
export type ImSecretResult = { readonly status: 'awaiting_secret' | 'completed' | 'cancelled' | 'replay' | 'failed'; readonly fieldLabel?: string }
export type ImShortcut = { readonly action: 'run' | 'drop' }
  | { readonly action: 'cancel'; readonly reply: string; readonly reference: string }
  | { readonly action: 'no_permission' | 'reply'; readonly reply: string }
export interface ImPreflightPorts {
  /** 每次按完整作用域复核启用、归属和群开关；未知 Telegram 私聊仍可执行绑定。 */
  authorize(scope: ImPreflightScope, signal: AbortSignal): Promise<boolean>
  /** 只查当前私聊；必须先跨该 scope 的旧 prompt 查重放，再查活动 stage。 */
  inspectSecret(scope: ImPreflightScope, signal: AbortSignal): Promise<ImSecretStage>
  /** 原子复核 scope/stage/事件幂等并加密暂存；禁止值进入普通历史、日志和恢复 payload。 */
  applySecret(scope: ImPreflightScope, reference: string, action: ImSecretAction, signal: AbortSignal): Promise<ImSecretResult>
  /** Python QQ 首次私聊绑定规则，必须由既有可信 Bot 服务原子实现。 */
  bindQqOwnerIfUnbound(scope: ImPreflightScope, signal: AbortSignal): Promise<void>
  consumeBinding(scope: ImPreflightScope, code: string, signal: AbortSignal): Promise<boolean>
  /** 必须复用统一交互及其恢复事务；不得把数字当成模型确认指令。 */
  consumeTextChoice(scope: ImPreflightScope, text: string, signal: AbortSignal): Promise<ImTextChoiceResult | null>
  decideShortcut(scope: ImPreflightScope, text: string, signal: AbortSignal): Promise<ImShortcut>
  /** 必须再次检查活跃 Run 发起者及完整 scope；true 仅表示 durable 取消已写入。 */
  cancel(scope: ImPreflightScope, reference: string, signal: AbortSignal): Promise<boolean>
  reply(scope: ImPreflightScope, text: string, options: { readonly quote: boolean; readonly signal: AbortSignal }): Promise<void>
}
export class ImPreflightError extends Error {
  constructor() { super('IM 入站控制消息暂时无法处理'); this.name = 'ImPreflightError' }
}

/** 只生成判定文本，不修改入库原文；只在明确 @ 当前 Bot 时移除一个 mention。 */
export function readImAddressedCommand(input: {
  text: string
  scope: { chatType: 'c2c' | 'group' }
  botMentioned: boolean
  qqAtEventOnly?: boolean
}) {
  const mentioned = input.botMentioned || input.qqAtEventOnly === true
  const semantic = imSemanticText(input.text, mentioned)
  const parsed = parseImControlCommand(semantic)
  const unaddressed = input.scope.chatType === 'group' && !mentioned ? parsed : null
  return { semantic, command: unaddressed ? null : parsed, unaddressed }
}

export function imSemanticText(text: string, botMentioned: boolean): string {
  const value = text.trim()
  if (botMentioned) {
    const command = value.replace(/^[@＠][^@＠/／\r\n]+(?=[/／])/u, '').trim()
    if (command !== value && parseImControlCommand(command)) return command
  }
  return botMentioned ? value.replace(/^\s*(?:<@!?[^>\s]+>|[@＠][^\s/／]+)\s*/u, '').trim() : value
}

/** 控制消息消费发生在下载、队列和历史之前；所有端口缺失均拒绝启动。 */
export function createImInboundPreflight(ports: ImPreflightPorts) {
  for (const name of ['authorize', 'inspectSecret', 'applySecret', 'bindQqOwnerIfUnbound', 'consumeBinding', 'consumeTextChoice', 'decideShortcut', 'cancel', 'reply'] as const)
    if (typeof ports[name] !== 'function') throw new TypeError('IM 入站控制服务未完整配置')
  return async (input: ImPreflightMessage, signal: AbortSignal): Promise<'enqueue' | 'consumed'> => {
    // 不保留网络 payload 或可变 scope，避免异步期间改变授权目标。
    const scope = Object.freeze({ ...input.scope })
    if (!scope.ownerId || !/^[1-9]\d*$/u.test(scope.botId) || !scope.platformUserId ||
      !['feishu', 'qq', 'wechat', 'telegram'].includes(scope.platform) ||
      !['c2c', 'group'].includes(scope.chatType) || (scope.chatType === 'group' && !scope.chatId) ||
      (scope.chatType === 'c2c' && scope.chatId !== null) ||
      typeof scope.eventId !== 'string' || typeof input.text !== 'string' || typeof input.hasPendingMedia !== 'boolean')
      throw new ImPreflightError()
    const text = input.text.trim()
    const reply = (value: string, quote = true) => ports.reply(scope, value, { quote, signal })
    try {
      signal.throwIfAborted()
      if (!await ports.authorize(scope, signal)) return 'consumed'
      signal.throwIfAborted()
      // 群聊凭据只通过 Web 私密表单处理，不能吞掉群里的普通消息。
      if (scope.chatType === 'c2c') {
        const stage = await ports.inspectSecret(scope, signal)
        if (['pending_choice', 'awaiting_secret'].includes(stage.status)
          && (!('reference' in stage) || typeof stage.reference !== 'string' || !stage.reference || stage.reference.length > 16_384))
          throw new ImPreflightError()
        signal.throwIfAborted()
        if (!stage || !['none', 'replay', 'ended', 'pending_choice', 'awaiting_secret'].includes(stage.status)) throw new ImPreflightError()
        if (stage.status === 'replay') return 'consumed'
        if (stage.status === 'ended') {
          await reply('凭据交互已结束，请重新发起后再输入。', false)
          return 'consumed'
        }
        const normalized = text.toLowerCase()
        const cancel = normalized === '取消' || normalized === 'cancel'
        const start = ['输入凭据', '输入', '开始输入', '1'].includes(normalized)
        const choiceCancel = cancel || normalized === '2'
        if (stage.status === 'awaiting_secret' || (stage.status === 'pending_choice' && (start || choiceCancel))) {
          if (stage.status === 'awaiting_secret' && (input.hasPendingMedia || !text)) {
            await reply('凭据请以纯文本逐项发送；取消输入请发送“取消”。', false)
            return 'consumed'
          }
          if (!scope.eventId) {
            await reply('凭据输入无法确认，请重新发起。', false)
            return 'consumed'
          }
          let result: ImSecretResult
          try {
            result = await ports.applySecret(scope, stage.reference, stage.status === 'pending_choice'
              ? { action: choiceCancel ? 'cancel' : 'start' }
              : cancel ? { action: 'cancel' } : { action: 'value', value: text }, signal)
            if (!result || !['awaiting_secret', 'completed', 'cancelled', 'replay', 'failed'].includes(result.status)) throw new ImPreflightError()
          } catch {
            signal.throwIfAborted()
            await reply('凭据字段无效或输入已结束，请重新发起。', false)
            return 'consumed'
          }
          if (result.status === 'replay') return 'consumed'
          // 字段标签来自可信 prompt 声明；永不回显输入值或引用敏感原消息。
          const label = result.fieldLabel || '凭据'
          await reply(result.status === 'completed' ? '凭据已安全保存。'
            : result.status === 'cancelled' ? '已取消凭据输入。'
              : result.status === 'failed' ? '凭据字段无效或输入已结束，请重新发起。'
              : `${stage.status === 'pending_choice' ? '请发送' : '请继续发送'}「${label}」的值。取消输入请发送“取消”。`, false)
          return 'consumed'
        }
      }
      if (scope.platform === 'telegram' && input.telegramCommand === 'bind') {
        signal.throwIfAborted()
        if (scope.chatType === 'c2c') {
          await handleTelegramBinding(text, code => ports.consumeBinding(scope, code, signal), reply)
        }
        return 'consumed'
      }
      if (scope.platform === 'qq' && scope.chatType === 'c2c') {
        signal.throwIfAborted()
        await ports.bindQqOwnerIfUnbound(scope, signal)
        if (await handleQqBinding(text, code => ports.consumeBinding(scope, code, signal), reply)) return 'consumed'
      }
      if (!text) return 'enqueue'
      signal.throwIfAborted()
      const { semantic, command, unaddressed } = readImAddressedCommand({ ...input, scope, text })
      if (input.hasPendingMedia && !command && !unaddressed) return 'enqueue'
      const choice = semantic && !input.hasPendingMedia ? await ports.consumeTextChoice(scope, semantic, signal) : null
      if (choice) {
        if (choice.status === 'replay') return 'consumed'
        await reply(choice.status === 'error' ? '交互尚未生效，请重新发起。'
          : choice.status === 'question_next' ? (choice.text || '请继续回答。')
          : choice.status === 'awaiting_text' ? '请直接发送你的回复，咕咕会继续处理。'
          : `已选择：${choice.text || '已选择'}，继续处理。`)
        return 'consumed'
      }
      if (unaddressed)
        return 'enqueue'
      const decision = await ports.decideShortcut(scope, semantic, signal)
      if (decision.action === 'run') return 'enqueue'
      if (decision.action === 'drop') return 'consumed'
      if (decision.action === 'cancel') {
        if (typeof decision.reference !== 'string' || !decision.reference || decision.reference.length > 128) throw new ImPreflightError()
        if (!await ports.cancel(scope, decision.reference, signal)) await reply('取消尚未生效，请稍后重试。')
        else await reply(decision.reply)
      } else if ('reply' in decision) await reply(decision.reply)
      return 'consumed'
    } catch {
      signal.throwIfAborted()
      // 原始异常可能含凭据/平台响应，禁止挂 cause 或原样向 Host 暴露。
      throw new ImPreflightError()
    }
  }
}
