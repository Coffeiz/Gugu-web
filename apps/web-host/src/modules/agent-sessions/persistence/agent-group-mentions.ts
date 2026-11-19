import { createPostgresAgentGroupNames } from '@gugu/core/agent-sessions'
import { extractPlatformMentionIds } from '@gugu/core/agent/context/messages'
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

function collectCandidateIds(messages: GroupMentionMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.platformBotUserId) ids.add(message.platformBotUserId)
    for (const text of [message.content, message.quotedText])
      for (const id of extractPlatformMentionIds(text)) ids.add(id)
  }
  return ids
}

async function latestSessionNames(pool: Pool, ownerId: string, sessionId: number, ids: string[]): Promise<Map<string, string>> {
  return createPostgresAgentGroupNames(pool)(ownerId, sessionId, ids)
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

  const names = await latestSessionNames(pool, ownerId, sessionId, [...candidateIds])
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
