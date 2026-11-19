import { imCanUseTool, imContextPolicy, resolveImAccess, resolveImActor, type ImAccess, type ImAccessScope, type ImActor, type ImActorInput, type ImBotAccess, type ImPlatform } from '@gugu/core/im/access'
import { normalizeUserBotTools } from '@gugu/core/im/user-bots'
import { normalizeOwnerId } from '../../../shared/owner-context.js'

export type ImAccessQuery = (statement: string, parameters: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
export interface PostgresImAccessSnapshot {
  readonly bot: ImBotAccess
  resolve(scope: ImAccessScope): ImAccess
  actor(input: ImActorInput): ImActor
  actorPolicy(input: ImActorInput, memoryEnabled: boolean): ReturnType<typeof imContextPolicy>
}
const platforms = new Set(['feishu', 'qq', 'wechat', 'telegram'])
const denied = () => new Error('IM 权限不可用')

function scopeOf(scope: ImAccessScope): ImAccessScope {
  try {
    if (!/^[1-9]\d{0,9}$/.test(scope.botId) || Number(scope.botId) > 2_147_483_647 || !platforms.has(scope.platform)
      || !['c2c', 'group'].includes(scope.chatType) || typeof scope.platformUserId !== 'string'
      || !scope.platformUserId || scope.platformUserId.length > 256 || /[\r\n\0]/.test(scope.platformUserId)) throw denied()
    return Object.freeze({ ownerId: normalizeOwnerId(scope.ownerId), botId: scope.botId, platform: scope.platform,
      chatType: scope.chatType, platformUserId: scope.platformUserId })
  } catch { throw denied() }
}
function sameBinding(left: ImAccessScope, right: ImAccessScope): boolean {
  return left.ownerId === right.ownerId && left.botId === right.botId && left.platform === right.platform && left.chatType === right.chatType
}
function inputOf(input: ImActorInput): ImActorInput {
  const scope = scopeOf(input)
  if (typeof input.botMentioned !== 'boolean' || typeof input.mentionsOtherBot !== 'boolean'
    || input.chatType === 'group' && (typeof input.chatId !== 'string' || !input.chatId || input.chatId.length > 256 || /[\r\n\0]/.test(input.chatId))) throw denied()
  try { return Object.freeze({ ...structuredClone(input), ...scope, chatId: scope.chatType === 'group' ? input.chatId : null }) }
  catch { throw denied() }
}

/** 每次读取均查询当前权威数据；不读取或解密平台凭据，也不缓存账户状态。 */
export function createPostgresImAccess(options: {
  query: ImAccessQuery
  supportedPlatforms(): readonly string[] | Promise<readonly string[]>
}) {
  async function readBot(raw: ImAccessScope): Promise<ImBotAccess | null> {
    const scope = scopeOf(raw)
    try {
      if (!(await options.supportedPlatforms()).includes(scope.platform)) return null
      const { rows } = await options.query(
        `SELECT b.id::text AS id,b.user_id::text AS owner_id,b.platform,b.enabled,
                b.owner_platform_user_id,b.group_allowed_tools,b.group_owner_memory_enabled,
                b.group_chat_enabled,b.feishu_group_chat_enabled,
                u.is_active,u.account_status
         FROM user_bots b JOIN users u ON u.id=b.user_id
         WHERE b.id=$1::integer AND b.user_id=$2::uuid AND b.platform=$3
           AND b.enabled IS TRUE AND u.is_active IS TRUE
           AND COALESCE(u.account_status,'active')='active'`,
        [scope.botId, scope.ownerId, scope.platform],
      )
      if (!rows.length) return null
      if (rows.length !== 1) throw denied()
      const row = rows[0]!
      // SQL限定之外再次复核投影，避免错误适配器或错误行形状建立可信身份。
      if (String(row.id) !== scope.botId || row.owner_id !== scope.ownerId || row.platform !== scope.platform
        || row.enabled !== true || row.is_active !== true || (row.account_status ?? 'active') !== 'active') return null
      // 群停用同样撤销旧Run的工具/出站权限；不能只在入站连接时检查一次。
      if (scope.chatType === 'group') {
        if (scope.platform === 'wechat') return null
        if (scope.platform === 'feishu') {
          if (row.feishu_group_chat_enabled !== null && typeof row.feishu_group_chat_enabled !== 'boolean') throw denied()
          if (row.feishu_group_chat_enabled === false) return null
        } else if (row.group_chat_enabled !== true) return null
      }
      if (row.owner_platform_user_id !== null && (typeof row.owner_platform_user_id !== 'string'
        || row.owner_platform_user_id.length > 128 || /[\r\n\0]/.test(row.owner_platform_user_id))
        || typeof row.group_owner_memory_enabled !== 'boolean'
        || row.group_allowed_tools !== null && (!Array.isArray(row.group_allowed_tools) || row.group_allowed_tools.some(value => typeof value !== 'string'))) throw denied()
      return Object.freeze({ id: scope.botId, ownerId: scope.ownerId, platform: row.platform as ImPlatform,
        ownerPlatformUserId: row.owner_platform_user_id as string | null,
        groupAllowedTools: Object.freeze(normalizeUserBotTools(row.group_allowed_tools)),
        groupOwnerMemoryEnabled: row.group_owner_memory_enabled })
    } catch { throw denied() }
  }
  async function snapshot(raw: ImAccessScope): Promise<PostgresImAccessSnapshot> {
    const scope = scopeOf(raw), bot = await readBot(scope)
    if (!bot) throw denied()
    function resolve(candidate: ImAccessScope) {
      const current = scopeOf(candidate)
      // 同批次不同speaker可以共享Bot读取；不能借快照进入另一owner、Bot、平台或私聊/群域。
      if (!sameBinding(scope, current)) throw denied()
      return resolveImAccess(current, bot)
    }
    return Object.freeze({ bot, resolve,
      actor(raw: ImActorInput) {
        try { const input = inputOf(raw); resolve(input); return resolveImActor(input, resolve) }
        catch { throw denied() }
      },
      actorPolicy(raw: ImActorInput, memoryEnabled: boolean) {
        const input = inputOf(raw)
        resolve(input)
        const actor = resolveImActor(input, resolve)
        return imContextPolicy(actor, bot, memoryEnabled)
      },
    })
  }
  async function resolveActor(raw: ImActorInput): Promise<ImActor> {
    const input = inputOf(raw), access = await snapshot(input)
    return access.actor(input)
  }
  return {
    readBot, snapshot, resolveActor,
    async authorizeTool(raw: ImActorInput, name: string, groupAutoReply = false): Promise<boolean> {
      const input = inputOf(raw)
      const bot = await readBot(input)
      if (!bot) return false
      try { return imCanUseTool(resolveImActor(input, scope => resolveImAccess(scope, bot)), name, groupAutoReply) }
      catch { throw denied() }
    },
    /** 旧Run权限撤销后停止交付；不能把owner上下文回复投递给已失去owner身份的人。 */
    async authorizeDelivery(expected: ImActor, expectedBot?: ImBotAccess): Promise<boolean> {
      const input = inputOf({ ...expected, botMentioned: expected.ownerMentionAuthorized, mentionsOtherBot: false,
        speakers: expected.speakerRoles ?? (expected.verifiedOwner ? [{ platformUserId: expected.platformUserId }] : undefined) })
      if (expectedBot && (!sameBinding(input, { ...input, ownerId: expectedBot.ownerId,
          botId: expectedBot.id, platform: expectedBot.platform }))) return false
      const bot = await readBot(input)
      if (!bot || expectedBot?.groupOwnerMemoryEnabled && !bot.groupOwnerMemoryEnabled) return false
      let current: ImActor
      try { current = resolveImActor(input, scope => resolveImAccess(scope, bot)) } catch { throw denied() }
      if (expected.role === 'owner' && current.role !== 'owner' || expected.verifiedOwner && !current.verifiedOwner) return false
      if (expected.allowedToolNames === null) return current.allowedToolNames === null
      return current.allowedToolNames === null || expected.allowedToolNames.every(name => current.allowedToolNames!.includes(name))
    },
  }
}
