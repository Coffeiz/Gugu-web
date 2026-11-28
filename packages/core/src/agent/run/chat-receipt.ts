import { createHash } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { CoreError } from '../../contracts/index.js'
import type { PoolClient } from 'pg'
import { withBorrowedAgentPostgres } from '../../data/borrowed-postgres.js'
import type { Database } from '../../data/schema.js'
import { stableJson } from '../context/history/canonical-history.js'

export function agentChatReceiptKey(ownerId: string, sessionId: number | null | undefined,
  clientId: string, input: unknown) {
  return {
    ownerKey: ownerId.toLowerCase().replaceAll('-', ''),
    sessionScope: sessionId ?? 0,
    clientId,
    fingerprint: createHash('sha256').update(stableJson(input)).digest('hex'),
  }
}

type Key = ReturnType<typeof agentChatReceiptKey>
type Receipt = { session_id: number; message_id: number; run_id: string; fingerprint: string }

/** 领用者先串行化同一请求，读取与写入均使用业务持有的事务。 */
export async function readAgentChatReceipt(db: Kysely<Database>, key: Key) {
  const { rows: [row] } = await sql<Receipt>`SELECT session_id,message_id,run_id,fingerprint
    FROM agent_chat_receipts WHERE owner_key=${key.ownerKey} AND session_scope=${key.sessionScope} AND client_id=${key.clientId}`.execute(db)
  if (row && row.fingerprint !== key.fingerprint) throw new CoreError('conflict', '消息标识已被使用')
  return row
}

export async function writeAgentChatReceipt(db: Kysely<Database>, key: Key,
  result: { sessionId: number; userMessageId: number; runId: string }) {
  await sql`INSERT INTO agent_chat_receipts(owner_key,session_scope,client_id,fingerprint,session_id,message_id,run_id)
    VALUES(${key.ownerKey},${key.sessionScope},${key.clientId},${key.fingerprint},${result.sessionId},${result.userMessageId},${result.runId})`.execute(db)
}

/** Web 使用已取得的事务连接，共用与 SQLite 相同的收件读写。 */
export function postgresAgentChatReceipts(client: PoolClient) {
  return {
    read: (key: Key) => withBorrowedAgentPostgres(client, db => readAgentChatReceipt(db, key)),
    write: (key: Key, result: Parameters<typeof writeAgentChatReceipt>[2]) =>
      withBorrowedAgentPostgres(client, db => writeAgentChatReceipt(db, key, result)),
  }
}
