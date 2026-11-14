import type { Pool } from 'pg'

export interface GroupMentionSession {
  chatType: string | null
  source: string | null
}

export interface GroupMentionMessage {
  content: string | null
  quotedText: string | null
  platformBotUserId: string | null
}

export interface LoadGroupMentionNamesInput {
  pool: Pool
  ownerId: string
  sessionId: number
  session: GroupMentionSession
  messages: GroupMentionMessage[]
  currentBotPlatformUserId: string | null
}

interface NameRow {
  id: string | null
  name: string | null
}

export function extractPlatformMentionIds(text: string | null | undefined): string[] {
  return [...new Set([...(text ?? '').matchAll(/<@!?([A-Za-z0-9_-]{1,64})>/g)].map((match) => match[1]!))]
}

export function replacePlatformMentionIds(text: string | null, names: ReadonlyMap<string, string>): string | null {
  if (text === null || names.size === 0) return text
  let result = text
  for (const [platformUserId, displayName] of names) {
    if (!platformUserId || !displayName) continue
    const escaped = platformUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(`<@!?${escaped}>|@${escaped}`, 'g'), () => `@${displayName}`)
  }
  return result
}

function collectCandidateIds(messages: GroupMentionMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.platformBotUserId) ids.add(message.platformBotUserId)
    for (const text of [message.content, message.quotedText])
      for (const id of extractPlatformMentionIds(text)) ids.add(id)
  }
  return ids
}

async function latestSessionNames(pool: Pool, sessionId: number, ids: string[]): Promise<Map<string, string>> {
  return queryNames({
    pool,
    sql: `SELECT DISTINCT ON (platform_user_id) platform_user_id AS id,platform_user_name AS name
     FROM conversation_messages
     WHERE session_id=$1 AND platform_user_id=ANY($2::text[])
       AND platform_user_name IS NOT NULL AND platform_user_name<>''
     ORDER BY platform_user_id,created_at DESC,id DESC`,
    params: [sessionId, ids],
  })
}

function namesById(rows: NameRow[], allowed?: ReadonlySet<string>): Map<string, string> {
  const names = new Map<string, string>()
  for (const row of rows)
    if (row.id && row.name && (!allowed || allowed.has(row.id)) && !names.has(row.id)) names.set(row.id, row.name)
  return names
}

async function queryNames(input: { pool: Pool; sql: string; params: unknown[]; allowed?: ReadonlySet<string> }): Promise<Map<string, string>> {
  const rows = await input.pool.query<NameRow>(input.sql, input.params)
  return namesById(rows.rows, input.allowed)
}

/** Resolve only known group-chat identities; unresolved platform IDs stay visible as-is. */
export async function loadGroupMentionNames(input: LoadGroupMentionNamesInput): Promise<Map<string, string>> {
  const { pool, ownerId, sessionId, session, messages, currentBotPlatformUserId } = input
  if (session.chatType !== 'group' || !session.source) return new Map()

  const candidateIds = collectCandidateIds(messages)
  if (candidateIds.size === 0) return new Map()

  const names = await latestSessionNames(pool, sessionId, [...candidateIds])
  if (currentBotPlatformUserId && candidateIds.has(currentBotPlatformUserId))
    names.set(currentBotPlatformUserId, names.get(currentBotPlatformUserId) ?? '咕咕')
  const unresolved = new Set([...candidateIds].filter((id) => !names.has(id)))
  if (unresolved.size) {
    for (const [id, name] of await queryNames({
      pool,
      sql: 'SELECT bot_platform_user_id AS id,name FROM user_bots WHERE user_id=$1 AND platform=$2 ORDER BY id',
      params: [ownerId, session.source],
      allowed: unresolved,
    })) {
      if (!names.has(id)) names.set(id, name)
    }
  }
  return names
}
