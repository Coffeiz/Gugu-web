import { agentContextPolicy, asAgentContextRecord, formatAgentDynamicSnapshotInput, formatAgentSource, type ContextData, type ContextSourcePorts, type ContextSourceSelection, type RunIdentity } from '@gugu/core/agent'
import type { ImActor } from '@gugu/core/im/access'
import { snapshotImMemory } from '@gugu/core/im/memory-context'
import { createAgentContextBuilder, type AgentContextBuilderPorts } from '@gugu/core/agent'

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
    const policy = agentContextPolicy({ source: actor.platform, actorContext: actor, memoryEnabled: selection.contextPolicy.memoryEnabled })
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
