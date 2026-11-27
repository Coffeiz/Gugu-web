import { agentCommandHelp, isAgentCommandHelpArgument } from '../agent/commands/help.js'
import { canonicalAgentCommandName, isPersonalWorkspaceSelection, parseAgentCommand } from '../agent/commands/menu.js'
import { length, strip } from '../shared/values.js'

export type ImShortcutState = 'idle' | 'thinking' | 'searching' | 'generating' | 'waiting_confirm' | 'waiting_agent'
export type ImShortcutIntent = 'progress' | 'cancel' | 'emotion' | 'ack' | 'run'
export type ImShortcutCommand = 'stop' | 'status' | 'compact' | 'help'
export type ImShortcutDecision = { readonly action: 'run' | 'compact' }
  | { readonly action: 'reply' | 'cancel' | 'no_permission'; readonly reply: string }
export interface ImShortcutOptions {
  readonly currentPlatformUserId?: string | null
  readonly activePlatformUserIds?: readonly string[] | ReadonlySet<string>
  readonly awaiting?: boolean
  /** 仅由可信平台mention事实开启，不能从正文自报。 */
  readonly allowLeadingMention?: boolean
  readonly hasAttachments?: boolean
  /** 当前入口实际已接通的命令；默认不宣传尚未接通的整理或其他执行命令。 */
  readonly helpCommands?: readonly string[]
}

const punctuation = new Set(' \t\n　。，、！？!?.~～…')
const cancelPunctuation = new Set([...punctuation, ...'，,：:'])
function trimCharacters(value: string, characters: ReadonlySet<string>): string {
  let start = 0, end = value.length
  while (start < end && characters.has(value[start]!)) start++
  while (end > start && characters.has(value[end - 1]!)) end--
  return value.slice(start, end)
}
// Python \s包括NEL/分隔控制符且不包括BOM；与str.strip采用同一空白语义。
const whitespace = '(?:[^\\S\\uFEFF]|[\\u001c-\\u001f\\u0085])'
const leadingMention = new RegExp(`^${whitespace}*(?:<@!?(?:(?!${whitespace}|>).)+>|[@＠](?:(?!${whitespace}|[/／]).)+)${whitespace}+(?=[/／])`, 'u')
const commands = new Set<string>(['stop', 'status', 'compact', 'help'])
const progressPunctuation = new Set(['?', '？', '??', '？？', '...', '。。。', '…', '在?', '在？'])
const acknowledgements = new Set(['嗯', '嗯嗯', '嗯呢', '好', '好的', '好滴', '好哒', '行', '行吧', '成', '中', '哦', '哦哦', '噢', 'ok', 'okay', 'okk', 'k', '收到', '了解', '明白', '懂了', '谢谢', '谢了', '多谢', 'thanks', 'thx', '哈哈', '哈哈哈', '嘿嘿', '赞', '👍', '👌', '🙏'])
const progress = new Set(['还在吗', '在吗', '在不在', '好了吗', '好了没', '弄好了吗', '完成了吗', '做完了吗', '查了吗', '查到了吗', '查好了吗', '搜到了吗', '搜好了吗', '找到了吗', '找到没', '怎么没反应', '怎么没回', '怎么没动静', '咋还没好', '进度', '进度呢', '怎么样了', '咋样了', '到哪了', '进度怎么样了', '进度怎么样', '进度如何', '现在怎么样了', '做到哪了', '弄到哪了'])
const cancelExact = new Set(['算了', '不用了', '不弄了', '别弄了', '别分析了', '先别弄', '先别', '停一下', '停下', '先停', '不做了', '取消', '别搞了', '先不弄', '不想弄了', '停止'])
const cancelCommand = new RegExp(`^(?:(?:请|麻烦|帮我|帮忙)${whitespace}*)?(?:取消|停止|终止)(?:${whitespace}*(?:(?:当前|现在|这个|刚才|刚刚|上一个|上一条)?(?:任务|操作|请求|执行|搜索|run)|一下|掉))?(?:${whitespace}*(?:吧|一下|好吗|可以吗))?$`, 'iu')
const emotionWords = ['急', '快点', '快快', '怎么还没', '怎么这么慢', '太慢', '等不及']
const emotionLeads = ['', '你', '咕咕', '你这', '咕咕你', '你怎么', '咕咕怎么']
const replies: Readonly<Record<ImShortcutState, string>> = { idle: '在的，你说～', thinking: '还在想哦，稍等一下下～', searching: '正在查资料，可能还要几秒～', generating: '正在整理内容，马上就好～', waiting_confirm: '在等你确认那一步哦～', waiting_agent: '正在等待子 Agent 的消息。' }

export function parseImControlCommand(text: string) {
  const parsed = parseAgentCommand(text)
  return parsed && (parsed.recognized || parsed.name === 'shell' && /^[/／]shell(?:\s|$)/iu.test(strip(text))) ? parsed : null
}

/** 帮助和未接通的命令可直接处理，不依赖运行状态或模型。 */
export function immediateImCommandReply(text: string, available: readonly string[]): string | null {
  const command = parseImControlCommand(text)
  if (!command) return null
  const { name, argument } = command
  if (name === 'shell' || name === 'help' && canonicalAgentCommandName(argument) === 'shell')
    return '会话级 /shell 范围切换已退役。发送 /workspace help 查看当前入口支持的工作区和授权操作。'
  if (!available.includes(name)) return `当前 IM 入口尚未提供 /${name} 命令。发送 /help 查看可用命令。`
  if (available.includes('workspace') && (
    name === 'workspace' && isAgentCommandHelpArgument(argument)
    || name === 'help' && canonicalAgentCommandName(argument) === 'workspace'
  )) return '在私聊中使用 /workspace 查看当前绑定，/workspace list 列出编号，/workspace <ID> 绑定，/workspace show 查看绑定，/workspace personal 切回个人文件，/workspace delete <ID> 删除工作区登记。'
  if (name === 'help') return agentCommandHelp(
    argument ? canonicalAgentCommandName(argument === '?' || argument === '？' ? 'help' : argument) : '', available,
    { '/workspace': '查看、绑定或解除当前会话的工作区' })
  return isAgentCommandHelpArgument(argument) ? agentCommandHelp(name, available) : null
}

/** IM 和桌面共用旧命令的参数语义；无参数只查询。 */
export async function runImAutomaticModeCommand(argument: string, ports: {
  owner: boolean; enabled: boolean; read(): Promise<boolean>; write(enabled: boolean): Promise<boolean>
}): Promise<string> {
  const value = argument.trim().toLowerCase()
  if (['', 'status', '状态'].includes(value)) {
    const active = await ports.read()
    return !active ? '自动模式：已关闭。' : ports.enabled
      ? '自动模式：已开启。普通操作确认可自动通过，权限授权和强制确认仍需确认。'
      : '偏好已开启，管理员当前未开放自动模式。'
  }
  if (!ports.owner) return '只有绑定 Bot 的用户可以切换自动模式。'
  const enable = ['on', '开启', '打开', '开'].includes(value)
  if (!enable && !['off', '关闭', '关'].includes(value))
    return '用法：/auto status 查看状态，/auto on 开启，/auto off 关闭。'
  if (enable && !ports.enabled) return '管理员当前未开放自动模式，暂时不能开启。'
  return await ports.write(enable) ? '自动模式已开启。权限授权和强制确认仍需确认。' : '自动模式已关闭。'
}

export async function runImForgetCommand(query: string, owner: boolean, forget: (query: string) => Promise<number>): Promise<string> {
  if (!owner) return '只有绑定 Bot 的用户可以删除个人记忆。'
  if (Array.from(query.replace(/[^\p{L}\p{N}]/gu, '')).length < 2 || query.length > 1000)
    return '请使用 /forget <内容> 指定要忘记的记忆。'
  const count = await forget(query)
  return count ? `已忘掉匹配的 ${count} 条记忆。` : '没有找到匹配的记忆。'
}

export function normalizeImWorkspaceArgument(argument: string): string {
  const value = argument.trim()
  const lower = value.toLowerCase()
  if (['', 'show', '查看', '当前'].includes(lower)) return 'show'
  if (['list', '列表'].includes(lower)) return 'list'
  if (isPersonalWorkspaceSelection(value)) return 'unlink'
  if (['off', 'none', 'unbind', 'unlink', '解除绑定', '取消绑定'].includes(lower)) return 'unlink'
  return value.replace(/^(STATUS|GOD|REVOKE)(?=\s|$)/iu, name => name.toLowerCase())
}

export function parseImWorkspaceDeletion(argument: string) {
  if (!/^(?:delete|rm|remove)(?:\s|$)/iu.test(argument.trim())) return null
  const [, number = '', confirmation, ...extra] = argument.trim().split(/\s+/u)
  const id = Number(number)
  if (!/^[1-9][0-9]*$/u.test(number) || !Number.isSafeInteger(id) || extra.length
    || (confirmation && !['confirm', 'yes', 'y', '确认', '确定'].includes(confirmation.toLowerCase())))
    return { kind: 'usage' as const }
  return { kind: confirmation ? 'confirmed' as const : 'prompt' as const, id }
}

export function parseImShortcutCommand(text: string, options: Pick<ImShortcutOptions, 'allowLeadingMention'> = {}): { command: ImShortcutCommand | null; argument: string } {
  const value = options.allowLeadingMention ? strip(text).replace(leadingMention, '') : strip(text)
  const parsed = parseAgentCommand(value.replaceAll('　', ' '))
  return {
    command: parsed?.recognized && commands.has(parsed.name) ? parsed.name as ImShortcutCommand : null,
    argument: parsed?.argument ?? '',
  }
}

export function isExplicitImCancel(text: string): boolean {
  const candidate = trimCharacters(text, cancelPunctuation)
  return cancelExact.has(candidate) || cancelCommand.test(candidate)
}

export function classifyImShortcutText(text: string): ImShortcutIntent {
  const raw = strip(text)
  if (!raw) return 'run'
  if (progressPunctuation.has(raw)) return 'progress'
  const value = trimCharacters(raw, punctuation)
  if (!value) return 'run'
  if (acknowledgements.has(value)) return 'ack'
  if (progress.has(value)) return 'progress'
  if (isExplicitImCancel(value)) return 'cancel'
  return length(value) <= 12 && emotionLeads.some(lead => emotionWords.some(word => value.startsWith(lead + word))) ? 'emotion' : 'run'
}

/** 只判意图，不读运行状态或执行取消；Host必须将cancel绑定到同scope的精确持久Run再复核。 */
export function decideImShortcut(text: string, state: string | null, options: ImShortcutOptions = {}): ImShortcutDecision {
  if (options.hasAttachments) return { action: 'run' }
  const current = options.currentPlatformUserId, active = new Set(options.activePlatformUserIds ?? [])
  const busy = Boolean(state && state !== 'idle') || Boolean(current && active.has(current))
  const { command, argument } = parseImShortcutCommand(text, options)
  const knownState = state !== null && Object.hasOwn(replies, state)
  const progressReply = knownState ? replies[state as ImShortcutState] : replies.idle
  const help = (name: string) => ({ action: 'reply' as const, reply: agentCommandHelp(name, options.helpCommands ?? ['stop', 'status', 'help']) })
  const allowedToCancel = Boolean(current && active.has(current))
  const denied = { action: 'no_permission' as const, reply: '这个不是你的任务哦，咕咕还在忙～' }
  if (command === 'stop') {
    if (isAgentCommandHelpArgument(argument)) return help('stop')
    // 显式安全收敛：旧Python斜杠分支未核对发起者；所有取消都必须有可信发起者事实。
    if (active.size && !allowedToCancel || busy && !allowedToCancel) return denied
    return busy ? { action: 'cancel', reply: '🛑 已停止当前任务' } : { action: 'reply', reply: '现在没有在跑的任务哦～' }
  }
  if (command === 'status') return isAgentCommandHelpArgument(argument) ? help('status') : { action: 'reply', reply: progressReply }
  if (command === 'help') return help(argument && !isAgentCommandHelpArgument(argument) ? argument : '')
  if (command === 'compact') return isAgentCommandHelpArgument(argument) ? help('compact') : { action: 'compact' }
  const intent = classifyImShortcutText(text)
  if (intent === 'progress') return busy ? { action: 'reply', reply: progressReply } : { action: 'run' }
  if (intent === 'emotion') return busy ? { action: 'reply', reply: knownState ? replies[state as ImShortcutState] : '马上好啦，我加把劲儿～' } : { action: 'run' }
  if (intent === 'cancel') {
    // Python先用原文完整匹配；仅在分类时剥掉的其他Unicode空白不能把闲时回答升级为控制。
    if (isExplicitImCancel(text) && active.size && !allowedToCancel || busy && !allowedToCancel) return denied
    return busy ? { action: 'cancel', reply: '好的，那这个先不继续啦～' } : { action: 'run' }
  }
  return { action: 'run' }
}

export function imReplyAwaitsAnswer(text: string): boolean {
  const value = Array.from(strip(text)), tail = value.slice(-24).join(''), punctuationTail = value.slice(-16).join('')
  return !!value.length && (/[？?]/u.test(punctuationTail) || ['要不要', '需要我', '要我', '好不好', '好吗', '行吗', '可以吗', '对吗', '是不是', '确认一下', '要吗', '成不成', '好不'].some(marker => tail.includes(marker)))
}

/** 旧Gateway的体验反馈，不参与路由或权限；只匹配本条原文，不读取引用正文。 */
export function chooseImInstantReactionEmoji(text: string, hasMedia: boolean): string {
  if (hasMedia) return 'OnIt'
  const value = text.toLowerCase()
  const rules: readonly (readonly [string, readonly string[]])[] = [
    ['LAUGH', ['哈哈', '23333', '笑死', '草', 'lol', 'hhh', '😂', '🤣']],
    ['THANKS', ['谢谢', '多谢', '感谢', '辛苦', 'thx', 'thanks', '🙏']],
    ['DONE', ['搞定', '完成', '好了', '弄好', 'done', '成了', '通过了']],
    ['WOW', ['厉害', '牛', '强', '哇', 'wow', '卧槽', '666', '绝了']],
    ['CRY', ['难过', '可惜', '唉', '崩溃', '麻了', '心疼', 'emo', '😭', '😢']],
    ['PARTY', ['恭喜', '庆祝', '上线', '发布', '纪念', '🎉']],
    ['OnIt', ['你好', '在吗', '在不在', '早', '晚上好', '中午好', 'hi', 'hello']],
    ['THINKING', ['为什么', '怎么', '如何', '?', '？', '吗', '呢', '请问', '能不能', '可不可以']],
  ]
  return rules.find(([, keywords]) => keywords.some(keyword => value.includes(keyword)))?.[0] ?? 'OnIt'
}
