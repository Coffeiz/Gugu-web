import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { stableJson, type ContextSourceSelection, type RunIdentity } from '@gugu/core/agent'
import { imContextPolicy, type ImActor, type ImBotAccess } from '@gugu/core/im/access'
import { normalizeUserBotTools } from '@gugu/core/im/user-bots'
import { agentContextAccessScope } from '../../agent/model-config/access-scope.js'
import { readConfiguredAgentProviderSettings } from '../../agent/model-config/configured-provider-settings.js'
import { createWebAgentProviderBinding } from '../../agent/model-config/web-provider-binding.js'
import { readConfigOverride } from '../../../adapters/config/config-override-file.js'

type Recovery = { identity: RunIdentity; modelIdentity: string; accessScopeHash: string }
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

/** 参数只接受当前可信权限解析器的 actor/Bot；此函数不从消息正文推断权限。 */
export function freezeImAgentProviderScope(identity: RunIdentity, actor: ImActor, bot: ImBotAccess, memoryEnabled: boolean) {
  if (!identity.ownerId || !identity.runId || !/^[1-9]\d*$/.test(identity.sessionId)
    || identity.ownerId !== actor.ownerId || bot.ownerId !== actor.ownerId || bot.id !== actor.botId || bot.platform !== actor.platform
    || !['feishu', 'qq', 'wechat', 'telegram'].includes(actor.platform) || !['c2c', 'group'].includes(actor.chatType)
    || !actor.platformUserId || (actor.chatType === 'group' ? !actor.chatId : actor.chatId !== null)
    || !['owner', 'member', 'unknown'].includes(actor.role) || typeof actor.verifiedOwner !== 'boolean'
    || typeof actor.ownerMentionAuthorized !== 'boolean' || typeof memoryEnabled !== 'boolean') throw new TypeError('IM 模型绑定身份或策略无效')
  const frozenActor = structuredClone(actor), frozenBot = structuredClone(bot)
  const policy = Object.freeze(imContextPolicy(frozenActor, frozenBot, memoryEnabled))
  // 包含完整参与者与权限投影；群内不同 speaker 也不能复用 owner 的上下文绑定。
  const contextBinding = stableJson(['im-agent-provider-v1', frozenActor.ownerId, frozenActor.platform, frozenActor.botId,
    frozenActor.chatType, frozenActor.chatType === 'group' ? frozenActor.chatId : frozenActor.platformUserId,
    frozenActor.platformUserId, frozenActor.role, frozenActor.verifiedOwner, frozenActor.ownerMentionAuthorized,
    frozenActor.allowedToolNames === null ? null : [...frozenActor.allowedToolNames].sort(),
    frozenActor.speakerRoles === null ? null : [...frozenActor.speakerRoles].sort((a, b) => a.platformUserId < b.platformUserId ? -1 : a.platformUserId > b.platformUserId ? 1 : 0),
    frozenBot.ownerPlatformUserId, normalizeUserBotTools(frozenBot.groupAllowedTools).sort(), frozenBot.groupOwnerMemoryEnabled, policy])
  return Object.freeze({ groupChat: actor.chatType === 'group', contextPolicy: policy, contextBinding })
}

/** 复用文件锁 + PG repeatable-read 快照及原有可恢复 Provider；不创建另一套模型循环。 */
export async function createConfiguredImAgentProviderBinding(options: {
  pool: Pick<Pool, 'connect'>; configPath: string; versionSecret: string; promptRoot: string
  environment: NodeJS.ProcessEnv; permissionIdentity: string; defaultLimit6h: number | null
}) {
  if (!options.permissionIdentity.trim()) throw new TypeError('IM Agent 权限版本未配置')
  const configured = await readConfiguredAgentProviderSettings(options)
  const key = (identity: RunIdentity) => JSON.stringify([identity.ownerId, identity.sessionId, identity.runId])
  const scopes = new Map<string, ReturnType<typeof freezeImAgentProviderScope>>()
  // 一份底层绑定保留原有预设池轮询/在途计数，不为每条消息重建模型选择器。
  const binding = createWebAgentProviderBinding({ pool: options.pool, configPath: options.configPath,
    versionSecret: options.versionSecret, defaultLimit6h: options.defaultLimit6h,
    readConfiguration: readConfigOverride, ...configured,
    async resolveAccessScope(target, model, credentials, permissions) {
      const scope = scopes.get(key(target))
      if (!scope) throw new Error('IM 模型绑定身份不匹配')
      return agentContextAccessScope(options.versionSecret, target, scope, { permissions, model, credentials }, digest, scope.contextBinding)
    },
  })
  async function scoped<T>(identity: RunIdentity, actor: ImActor, bot: ImBotAccess, memoryEnabled: boolean,
    work: (scope: ReturnType<typeof freezeImAgentProviderScope>) => Promise<T>): Promise<T> {
    const scope = freezeImAgentProviderScope(identity, actor, bot, memoryEnabled), id = key(identity)
    // 同一 run 的并发绑定不能替换在途权限材料；不同 run 由原有配置锁正常串行。
    if (scopes.has(id)) throw new Error('IM 模型绑定正在进行')
    scopes.set(id, scope)
    try { return await work(scope) } finally { scopes.delete(id) }
  }
  return {
    async accessVersion(identity: RunIdentity, actor: ImActor, bot: ImBotAccess, memoryEnabled: boolean) {
      identity = Object.freeze({ ...identity })
      return scoped(identity, actor, bot, memoryEnabled, () => binding.accessVersion(identity))
    },
    async bindRun(identity: RunIdentity, actor: ImActor, bot: ImBotAccess, memoryEnabled: boolean,
      locale: string | null, recovery?: Recovery, signal = new AbortController().signal) {
      identity = Object.freeze({ ...identity })
      const selectedLocale = locale ?? 'zh-CN'
      if (!['zh-CN', 'ja-JP', 'en-US'].includes(selectedLocale)) throw new TypeError('IM Agent 语言无效')
      return scoped(identity, actor, bot, memoryEnabled, async scope => {
        const bound = await binding.bind(identity, signal, recovery)
        const selection: ContextSourceSelection = Object.freeze({ modelIdentity: bound.modelIdentity, contextWindow: bound.contextWindow,
          locale: selectedLocale, groupChat: scope.groupChat, workspaceBinding: null, contextPolicy: scope.contextPolicy, contextScopeKey: bound.contextScopeKey })
        return { selection, resolve: bound.resolve, usageConfig: bound.usageConfig, release: bound.release }
      })
    },
  }
}
