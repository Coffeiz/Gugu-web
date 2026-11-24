import { asAgentContextRecord, formatAgentDynamicSnapshotInput, formatAgentSource } from '../../context/prompt-format.js'
import { createAgentContextBuilder, type AgentContextBuilderPorts } from '../../context/builder.js'
import type { ContextData, ContextSourceSelection, RunIdentity } from '../../models.js'
import type { ContextSourcePorts } from '../../ports.js'
import { snapshotImMemory } from '../../../im/memory-context.js'
import { agentContextPolicy } from '../source-policy.js'
import type { ImActor, ImBotAccess } from '../../../im/access.js'
import { imOwnerPrivate } from './tools.js'

const blacklist = new Set(['smart_view', 'object_cards', 'app_deep_links', 'open_item_reference'])
export function imAllowsPrompt(block: string): boolean { return !blacklist.has(block) }

export const imChannelInstruction = '## 当前渠道\n当前会话是即时通讯。使用当前渠道支持的 Markdown、链接和原生附件。图表和公式按渠道能力交付，缺少渲染能力时使用文字或表格。不输出 gugu-ui 围栏、gugu-ui-dsl 围栏或 gugu-ui-stream 围栏。'

export function imActorContextPolicy(actor: ImActor, memoryEnabled: boolean, bindingMatches = true) {
  return agentContextPolicy({ source: actor.platform,
    actorContext: imOwnerPrivate(actor) && bindingMatches ? actor : { role: 'member' }, memoryEnabled })
}

export function imContextPolicy(actor: ImActor, bot: ImBotAccess | null, memoryEnabled: boolean) {
  if (typeof memoryEnabled !== 'boolean') throw new TypeError('IM 记忆开关必须由可信配置提供')
  const bindingMatches = bot?.id === actor.botId && bot.ownerId === actor.ownerId && bot.platform === actor.platform
    && bot.ownerPlatformUserId === actor.platformUserId
  return Object.freeze({
    ...imActorContextPolicy(actor, memoryEnabled, bindingMatches),
    groupOwnerMemoryEnabled: bindingMatches && imCanUseGroupOwnerMemory(actor, bot.groupOwnerMemoryEnabled),
  })
}

/** 群聊中的主人个人记忆只可在可信平台身份已验证且开关开启时召回。 */
export function imCanUseGroupOwnerMemory(actor: ImActor, enabled: boolean): boolean {
  if (typeof enabled !== 'boolean') throw new TypeError('群主个人记忆开关必须由可信配置提供')
  return actor.chatType === 'group' && actor.role === 'owner' && actor.verifiedOwner && enabled
}


/** IM快照复用现有静态/业务格式化端口，显式投影平台来源和受限scope记忆。 */
export function createImAgentContextBuilder(actor: ImActor, ports: Omit<AgentContextBuilderPorts, 'dynamic'> & {
  dynamic?: AgentContextBuilderPorts['dynamic']
  /** 默认格式化器不读取全局时钟，Host必须显式提供同一快照时刻。 */
  now?(): number
}): ContextSourcePorts['builder'] {
  if (typeof ports.dynamic !== 'function' && typeof ports.now !== 'function') throw new TypeError('IM 快照时钟未配置')
  const scope = JSON.stringify([actor.ownerId, actor.platform, actor.botId, actor.chatType,
    actor.chatType === 'group' ? actor.chatId : actor.platformUserId, actor.platformUserId, actor.role, actor.verifiedOwner])
  function assertScope(selection: ContextSourceSelection, identity: RunIdentity) {
    const policy = imActorContextPolicy(actor, selection.contextPolicy.memoryEnabled)
    if (typeof selection.contextPolicy.memoryEnabled !== 'boolean'
      || identity.ownerId !== actor.ownerId || selection.groupChat !== (actor.chatType === 'group')
      || selection.contextPolicy.loadOwnerContext !== policy.loadOwnerContext)
      throw new Error('IM 上下文身份或策略不匹配')
  }
  const base = createAgentContextBuilder({
    ...ports,
    sessionInfo(selection, identity, preferences) {
      return { ...ports.sessionInfo(selection, identity, preferences), source: actor.platform, imScopeKey: scope,
        stylePreferences: selection.contextPolicy.loadOwnerContext ? preferences ?? {} : {} }
    },
    dynamic(data, selection, identity) {
      const value = ports.dynamic ? ports.dynamic(data, selection, identity)
        : formatAgentDynamicSnapshotInput(data, selection.contextPolicy, actor.platform, ports.now!())
      const channels = asAgentContextRecord(data.imChannels, 'IM 渠道状态')
      return { ...value, sourceBlock: formatAgentSource(actor.platform,
        Object.fromEntries(['feishu', 'qq', 'wechat', 'telegram'].map(name => [name, channels[name] === true]))) }
    },
  })
  return {
    buildSnapshot(data, selection, identity) {
      assertScope(selection, identity)
      // Core来源读取器已经限制读取；格式化时再次裁剪，避免直接调用builder泄漏owner域。
      const visible: ContextData = selection.contextPolicy.loadOwnerContext ? {
        ...data, memory: selection.contextPolicy.memoryEnabled ? data.memory : {},
      } : {
        ...data, projects: [], events: [], notes: [], filesOverview: {}, stylePreferences: {}, memory: {}, imChannels: {}, knowledge: [],
      }
      // 通用业务格式化器不消费原始IM资料；scope记忆只经下方专用投影进入快照。
      visible.imMemory = {}
      const snapshot = base.buildSnapshot(visible, selection, identity)
      const im = snapshotImMemory(snapshot.snapshotContext, data.imMemory, actor, selection.contextPolicy.memoryEnabled)
      return { ...snapshot, snapshotContext: im.snapshotContext, imMemory: im.imMemory }
    },
    buildRequest(snapshot, selection, identity) {
      assertScope(selection, identity)
      const info = snapshot.sessionInfo
      if (!info || typeof info !== 'object' || Array.isArray(info) || info.imScopeKey !== scope)
        throw new Error('IM 快照会话作用域不匹配')
      return base.buildRequest(snapshot, selection, identity)
    },
  }
}
