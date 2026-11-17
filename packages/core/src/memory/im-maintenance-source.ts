import { sql, type Kysely } from 'kysely'

export interface ImMaintenanceCursor {
  owner_user_id: string
  platform: string
  bot_id: string
  scope_type: 'group' | 'platform-user'
  scope_id: string
  first_message_id: number
  last_message_id: number
}

export interface ImMaintenanceMessage {
  id: number
  conversation_seq: number
  role: string
  content: string
  platform_user_id: string | null
  platform_user_name: string | null
  created_at: Date | string | null
}

function component(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() === '.' || value.trim() === '..'
    || /[/\\\0]/u.test(value)) throw new TypeError(`IM 记忆作用域 ${field} 无效`)
  return value.trim()
}

function cursor(row: Record<string, unknown>): ImMaintenanceCursor {
  const scopeType = row.scope_type
  if (scopeType !== 'group' && scopeType !== 'platform-user') throw new TypeError('IM 记忆作用域类型无效')
  const last = Number(row.last_message_id ?? 0)
  const reflected = Number(row.last_reflected_message_id ?? 0)
  if (!Number.isSafeInteger(last) || last < 0 || !Number.isSafeInteger(reflected) || reflected < 0)
    throw new TypeError('IM 记忆消息游标无效')
  return {
    owner_user_id: component(row.owner_user_id, 'owner_user_id'),
    platform: component(row.platform, 'platform'),
    bot_id: component(row.bot_id, 'bot_id'),
    scope_type: scopeType,
    scope_id: component(row.scope_id, 'scope_id'),
    first_message_id: reflected + 1,
    last_message_id: last,
  }
}

/** Core 只读 IM 维护输入。Host 负责管理员权限、模型调用与 Local 文件适配。 */
export function createImMaintenanceSource<DB>(db: Kysely<DB>) {
  return {
    async listCursors(): Promise<ImMaintenanceCursor[]> {
      const rows = (await sql<Record<string, unknown>>`
        SELECT owner_user_id,platform,bot_id,scope_type,scope_id,last_message_id,last_reflected_message_id
        FROM memory_reflection_cursors ORDER BY updated_at DESC
      `.execute(db)).rows
      return rows.map(cursor)
    },

    async messages(scope: Pick<ImMaintenanceCursor, 'owner_user_id' | 'platform' | 'bot_id' | 'scope_type' | 'scope_id'>, fromId: number, toId: number): Promise<ImMaintenanceMessage[]> {
      const ownerId = component(scope.owner_user_id, 'owner_user_id')
      const platform = component(scope.platform, 'platform')
      const botId = component(scope.bot_id, 'bot_id')
      const scopeId = component(scope.scope_id, 'scope_id')
      if (!Number.isSafeInteger(fromId) || fromId < 0 || !Number.isSafeInteger(toId) || toId < fromId)
        throw new TypeError('IM 记忆消息范围无效')
      if (scope.scope_type !== 'group' && scope.scope_type !== 'platform-user') throw new TypeError('IM 记忆作用域类型无效')

      const member = scope.scope_type === 'platform-user'
      const split = scopeId.indexOf(':')
      const groupId = member && split >= 0 ? scopeId.slice(0, split) : ''
      const memberId = member ? (split >= 0 ? scopeId.slice(split + 1) : scopeId) : ''
      if (member && !memberId) throw new TypeError('IM 记忆成员作用域无效')
      const scopeFilter = scope.scope_type === 'group'
        ? sql`AND s.chat_type = 'group' AND s.chat_id = ${scopeId}`
        : groupId
          ? sql`AND m.platform_user_id = ${memberId} AND s.chat_type = 'group' AND s.chat_id = ${groupId}`
          : sql`AND m.platform_user_id = ${memberId} AND s.chat_type != 'group'`
      const rows = (await sql<ImMaintenanceMessage>`
        SELECT m.id,m.conversation_seq,m.role,m.content,m.platform_user_id,m.platform_user_name,m.created_at
        FROM conversation_messages AS m
        JOIN conversation_sessions AS s ON s.id = m.session_id
        WHERE s.user_id = ${ownerId} AND s.source = ${platform} AND s.bot_id = ${botId}
          AND m.id >= ${fromId} AND m.id <= ${toId}
          AND m.role = 'user' AND m.platform_user_id IS NOT NULL
          ${scopeFilter}
        ORDER BY m.conversation_seq
      `.execute(db)).rows
      return rows
    },

    async isTombstoned(scope: Pick<ImMaintenanceCursor, 'owner_user_id' | 'platform' | 'bot_id' | 'scope_type' | 'scope_id'>): Promise<boolean> {
      const ownerId = component(scope.owner_user_id, 'owner_user_id')
      const platform = component(scope.platform, 'platform')
      const botId = component(scope.bot_id, 'bot_id')
      const scopeId = component(scope.scope_id, 'scope_id')
      if (scope.scope_type !== 'group' && scope.scope_type !== 'platform-user') throw new TypeError('IM 记忆作用域类型无效')
      const row = (await sql<{ id: number }>`
        SELECT 1 AS id FROM memory_scope_tombstones
        WHERE owner_user_id = ${ownerId} AND platform = ${platform} AND bot_id = ${botId}
          AND scope_type = ${scope.scope_type} AND scope_id = ${scopeId} LIMIT 1
      `.execute(db)).rows[0]
      return row !== undefined
    },
  }
}
