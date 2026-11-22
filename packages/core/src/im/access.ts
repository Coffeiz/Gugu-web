import { canUseTool, filterToolNames } from '../agent/tools/permissions.js'
import { agentContextPolicy } from '../agent/context/source-policy.js'
import { normalizeUserBotTools } from './user-bots.js'

export type ImPlatform = 'feishu' | 'qq' | 'wechat' | 'telegram'
export type ImRole = 'owner' | 'member' | 'unknown'
export type ImChatType = 'c2c' | 'group'
/** 群回应模式由Host当前Bot配置提供；不采用消息正文或模型给出的策略。 */
export function classifyImGroupInbound(input: { platform: ImPlatform; chatType: ImChatType; chatId: string | null;
  groupMentioned: boolean; mentionsOtherBot: boolean }, settings: { readOnly: boolean; requiresAt: boolean }): 'reply' | 'passive' | null {
  if (!['qq', 'feishu', 'telegram'].includes(input.platform) || input.chatType !== 'group' || !input.chatId) return null
  if (typeof settings.readOnly !== 'boolean' || typeof settings.requiresAt !== 'boolean') throw new TypeError('IM 群回应策略无效')
  return settings.readOnly || !input.groupMentioned && (settings.requiresAt || input.mentionsOtherBot) ? 'passive' : 'reply'
}
export const defaultImTools: readonly string[] = Object.freeze(['web_search', 'http_get', 'similar_image_search', 'save_attachment'])

/** 只能由 Host 从可信 Bot 存储读取；平台消息不得自行提供绑定和权限。 */
export interface ImBotAccess {
  readonly id: string
  readonly ownerId: string
  readonly platform: ImPlatform
  readonly ownerPlatformUserId: string | null
  readonly groupAllowedTools: unknown
  readonly groupOwnerMemoryEnabled: boolean
}
export interface ImAccessScope {
  readonly ownerId: string
  readonly botId: string
  readonly platform: ImPlatform
  readonly chatType: ImChatType
  readonly platformUserId: string
}
export interface ImAccess {
  readonly role: ImRole
  readonly allowedToolNames: readonly string[] | null
  readonly groupMemberToolNames?: readonly string[]
}
function matches(bot: ImBotAccess | null, scope: ImAccessScope): bot is ImBotAccess {
  return !!bot && bot.id === scope.botId && bot.ownerId === scope.ownerId && bot.platform === scope.platform
}

/** 保留 Python 各平台差异；可信身份的建立及停用检查由 Host 在调用前完成。 */
export function resolveImAccess(scope: ImAccessScope, bot: ImBotAccess | null): ImAccess {
  const unknown = (): ImAccess => ({ role: 'unknown', allowedToolNames: [...defaultImTools] })
  if (!/^[1-9]\d*$/.test(scope.botId)) return unknown()
  if (!matches(bot, scope)) return scope.platform === 'qq'
    ? { role: 'unknown', allowedToolNames: normalizeUserBotTools(null) } : unknown()
  // 飞书/微信旧私聊owner规则只适用于当前可信Bot连接，不能绕过Bot归属匹配。
  if ((scope.platform === 'feishu' || scope.platform === 'wechat') && scope.chatType === 'c2c')
    return { role: 'owner', allowedToolNames: null }
  const memberTools = normalizeUserBotTools(bot.groupAllowedTools)
  if (scope.platform === 'qq' && !bot.ownerPlatformUserId)
    return { role: 'unknown', allowedToolNames: normalizeUserBotTools(null) }
  if (scope.platformUserId && bot.ownerPlatformUserId === scope.platformUserId)
    return { role: 'owner', allowedToolNames: null, groupMemberToolNames: memberTools }
  if (scope.platform === 'telegram' && (scope.chatType !== 'group' || !scope.platformUserId)) return unknown()
  return { role: 'member', allowedToolNames: memberTools }
}

export interface ImActorInput extends ImAccessScope {
  readonly chatId: string | null
  readonly botMentioned: boolean
  readonly mentionsOtherBot: boolean
  /** 缺失表示没有批次身份事实；空数组不构成 owner 证明。 */
  readonly speakers?: readonly { readonly platformUserId: string }[]
  readonly batchMessages?: readonly { readonly platformUserId: string; readonly chatType: ImChatType; readonly botMentioned: boolean; readonly mentionsOtherBot: boolean }[]
}
export interface ImActor extends ImAccessScope {
  readonly chatId: string | null
  readonly role: ImRole
  readonly allowedToolNames: readonly string[] | null
  readonly speakerRoles: readonly { readonly platformUserId: string; readonly role: ImRole }[] | null
  readonly verifiedOwner: boolean
  readonly ownerMentionAuthorized: boolean
}
/** 从可信解析/密封收据恢复身份事实；批次发言人只从逐条消息推导，不信任汇总角色字段。 */
export function imActorInputFromPayload(binding: Pick<ImAccessScope, 'ownerId' | 'botId' | 'platform'>, payload: Readonly<Record<string, unknown>>): ImActorInput {
  const invalid = (): never => { throw new TypeError('IM 入站身份事实无效') }
  function one(value: Readonly<Record<string, unknown>>): ImActorInput {
    if (value.owner_user_id !== binding.ownerId || value.platform !== binding.platform
      || (value.bot_id ?? value.channel_id) !== binding.botId
      || value.bot_id !== undefined && value.bot_id !== binding.botId || value.channel_id !== undefined && value.channel_id !== binding.botId
      || typeof value.platform_user_id !== 'string' || !value.platform_user_id
      || !['group', 'c2c'].includes(String(value.chat_type))
      || value.chat_type === 'group' && (typeof value.chat_id !== 'string' || !value.chat_id)) return invalid()
    return { ...binding, chatType: value.chat_type as ImChatType, chatId: value.chat_type === 'group' ? value.chat_id as string : null,
      platformUserId: value.platform_user_id, botMentioned: value.bot_mentioned === true, mentionsOtherBot: value.mentions_other_bot === true }
  }
  const input = one(payload)
  if (payload._batch_messages === undefined) return input
  if (!Array.isArray(payload._batch_messages) || !payload._batch_messages.length || payload._batch_messages.length > 128) return invalid()
  const messages = payload._batch_messages.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
    const item = one(value as Record<string, unknown>)
    if (item.chatType !== input.chatType || item.chatId !== input.chatId
      || input.chatType === 'c2c' && item.platformUserId !== input.platformUserId) return invalid()
    return item
  })
  if (messages.at(-1)!.platformUserId !== input.platformUserId) return invalid()
  return { ...input, speakers: messages.map(message => ({ platformUserId: message.platformUserId })),
    batchMessages: messages.map(message => ({ platformUserId: message.platformUserId, chatType: message.chatType,
      botMentioned: message.botMentioned, mentionsOtherBot: message.mentionsOtherBot })) }
}
const rank: Record<ImRole, number> = { owner: 0, member: 1, unknown: 2 }
function intersect(left: readonly string[] | null, right: readonly string[] | null): readonly string[] | null {
  if (left === null) return right === null ? null : [...right]
  return right === null ? [...left] : left.filter(name => right.includes(name))
}
function memberTools(access: ImAccess): readonly string[] {
  // Python 的空 member 白名单在 owner 降级时同样采用最低默认集合。
  return access.groupMemberToolNames?.length ? access.groupMemberToolNames : defaultImTools
}

/** 纯规则移植；访问解析端口可复用同一可信 Bot 快照，不读取 Host 数据库。 */
export function resolveImActor(input: ImActorInput, resolve: (scope: ImAccessScope) => ImAccess): ImActor {
  if (!input.ownerId || !input.botId || !input.platformUserId || (input.chatType === 'group' && !input.chatId))
    throw new TypeError('IM 身份作用域不完整')
  const access = resolve(input)
  let role = access.role
  let allowedToolNames = role === 'unknown' && access.allowedToolNames === null ? [...defaultImTools] : access.allowedToolNames
  let verifiedOwner = role === 'owner'
  const ownerMentionAuthorized = input.chatType === 'group' && role === 'owner' && input.botMentioned && !input.mentionsOtherBot &&
    (input.batchMessages === undefined || (input.batchMessages.length === 1 && input.batchMessages[0]!.platformUserId === input.platformUserId &&
      input.batchMessages[0]!.chatType === 'group' && input.batchMessages[0]!.botMentioned && !input.batchMessages[0]!.mentionsOtherBot))
  const speakers = [...new Set((input.speakers ?? []).map(speaker => speaker.platformUserId))].sort()
  let speakerRoles: ImActor['speakerRoles'] = null
  if (speakers.length > 1 || (speakers.length === 1 && speakers[0] !== input.platformUserId)) {
    const resolved = speakers.map(platformUserId => ({ platformUserId, access: platformUserId ? resolve({ ...input, platformUserId }) : { role: 'unknown' as const, allowedToolNames: defaultImTools } }))
    const allOwners = resolved.length > 0 && resolved.every(speaker => speaker.access.role === 'owner')
    speakerRoles = resolved.map(speaker => {
      const downgraded = input.chatType === 'group' && speaker.access.role === 'owner' && !allOwners
      const speakerRole = downgraded ? 'member' : speaker.access.role
      const tools = downgraded ? memberTools(speaker.access) : speaker.access.allowedToolNames
      if (rank[speakerRole] > rank[role]) role = speakerRole
      allowedToolNames = intersect(allowedToolNames, speakerRole === 'unknown' && tools === null ? defaultImTools : tools)
      return Object.freeze({ platformUserId: speaker.platformUserId, role: speakerRole })
    })
    verifiedOwner = speakers.length > 1 && role === 'owner' && allOwners
  } else if (speakers.length && input.chatType === 'group' && role === 'owner') verifiedOwner = true
  else if (input.chatType === 'group' && role === 'owner' && !ownerMentionAuthorized) {
    role = 'member'
    allowedToolNames = memberTools(access)
  }
  return Object.freeze({ ownerId: input.ownerId, botId: input.botId, platform: input.platform, chatType: input.chatType,
    platformUserId: input.platformUserId, chatId: input.chatType === 'group' ? input.chatId : null, role,
    allowedToolNames: allowedToolNames === null ? null : Object.freeze([...allowedToolNames]),
    speakerRoles: speakerRoles === null ? null : Object.freeze(speakerRoles), verifiedOwner, ownerMentionAuthorized })
}

export function imContextPolicy(actor: ImActor, bot: ImBotAccess | null, memoryEnabled: boolean) {
  if (typeof memoryEnabled !== 'boolean') throw new TypeError('IM 记忆开关必须由可信配置提供')
  return Object.freeze({ ...agentContextPolicy({ source: actor.platform, actorContext: actor, memoryEnabled }),
    groupOwnerMemoryEnabled: actor.chatType === 'group' && (actor.role === 'owner' || actor.verifiedOwner) && matches(bot, actor) && bot.groupOwnerMemoryEnabled })
}

/** 群聊中的主人个人记忆只可在可信平台身份已验证且开关开启时召回。 */
export function imCanUseGroupOwnerMemory(actor: ImActor, enabled: boolean): boolean {
  if (typeof enabled !== 'boolean') throw new TypeError('群主个人记忆开关必须由可信配置提供')
  return actor.chatType === 'group' && actor.role === 'owner' && actor.verifiedOwner && enabled
}

const delegationTools = new Set(['agent_message', 'agent_wait', 'agent_cancel', 'agent_inspect', 'subagent_result'])

export function isImInternalDelegationTool(name: unknown): boolean {
  return typeof name === 'string' && delegationTools.has(name)
}

/** 复用现有发现/派发规则；平台不支持的工具在两个入口均不可见和不可执行。 */
export function imCanUseTool(actor: ImActor, name: string, groupAutoReply = false): boolean {
  if (isImInternalDelegationTool(name)
    && (actor.role !== 'owner' || actor.chatType !== 'c2c')) return false
  if (name === 'save_attachment' && (actor.role !== 'owner' || actor.chatType !== 'c2c')) return false
  if (name === 'react' && actor.platform !== 'feishu') return false
  return canUseTool(name, { allowedToolNames: actor.allowedToolNames, imRole: actor.role, platform: actor.platform,
    chatType: actor.chatType, currentIm: { chatType: actor.chatType, groupAutoReply } })
}

/** 展示偏好不改变工具权限；群隐藏过程，飞书私聊固定完整展示。 */
export function imDisplayPolicy(platform: ImPlatform, chatType: ImChatType, value: unknown): { toolDisplay: 'off' | 'all' | 'slow_only'; showIntermediateReplies: boolean } {
  if(chatType==='group')return{toolDisplay:'off',showIntermediateReplies:false}
  if(platform==='feishu')return{toolDisplay:'all',showIntermediateReplies:true}
  const data=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
  const mode=data.im_tool_display_mode
  const intermediate=data.show_intermediate_replies
  const truthy=Array.isArray(intermediate)?intermediate.length>0:intermediate&&typeof intermediate==='object'?Object.keys(intermediate).length>0:!!intermediate
  return{toolDisplay:mode==='off'||mode==='slow_only'?mode:'all',showIntermediateReplies:truthy}
}
export function imVisibleToolNames(actor: ImActor, system: readonly string[], groupAutoReply = false): string[] {
  return filterToolNames(system, actor.allowedToolNames).filter(name => imCanUseTool(actor, name, groupAutoReply))
}
