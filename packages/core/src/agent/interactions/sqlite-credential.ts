import { sql, type Transaction } from 'kysely'
import { CoreError, dataContext } from '../../contracts/index.js'
import type { Database } from '../../data/schema.js'
import { createMcpServerConfigLister } from '../../mcp/server-list.js'
import type { PendingInteraction, RunIdentity } from '../models.js'
import { describeMcpCredentialPrompt } from './prompt-description.js'
import { sqliteMcpCredentialVersion } from './sqlite-consume.js'

const intentKey = (identity: RunIdentity, request: PendingInteraction) => sql`
  user_id=${dataContext(identity.ownerId).ownerId.replaceAll('-', '')} AND session_id=${identity.sessionId}
  AND run_id=${identity.runId} AND interaction_id=${request.id} AND tool_call_id=${request.toolCall.id}`

async function readServer(tx: Transaction<Database>, owner: string, id: string) {
  const [row] = await createMcpServerConfigLister<Database>(tx, 'sqlite')(owner, tx, id)
  if (!row || row.scope !== 'user' || row.transport !== 'http'
    || !Array.isArray(row.credential_slots) || !row.credential_slots.length)
    throw new CoreError('conflict', 'MCP 凭据配置不存在')
  return row
}

export async function stageSqliteMcpCredential(tx: Transaction<Database>, identity: RunIdentity,
  request: PendingInteraction, serverId: string) {
  if (request.kind !== 'credential' || request.toolCall.name !== 'manage_mcp_servers')
    throw new CoreError('invalid_request', 'MCP 凭据交互绑定无效')
  const row = await readServer(tx, identity.ownerId, serverId)
  const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
  await sql`INSERT INTO desktop_agent_credential_intents
    (user_id,session_id,run_id,interaction_id,tool_call_id,server_id,configuration_version,expires_at)
    VALUES (${owner},${identity.sessionId},${identity.runId},${request.id},${request.toolCall.id},
      ${row.id},${sqliteMcpCredentialVersion(row)},${Date.now() + 600_000})`.execute(tx)
}

export async function describeSqliteMcpCredential(tx: Transaction<Database>, identity: RunIdentity, request: PendingInteraction) {
  const { rows: [intent] } = await sql<{ server_id: string; configuration_version: string }>`
    SELECT server_id,configuration_version FROM desktop_agent_credential_intents
    WHERE ${intentKey(identity, request)} AND expires_at>${Date.now()}`.execute(tx)
  if (!intent) throw new CoreError('conflict', '凭据填写意图已失效')
  const row = await readServer(tx, identity.ownerId, intent.server_id)
  if (sqliteMcpCredentialVersion(row) !== intent.configuration_version)
    throw new CoreError('conflict', 'MCP 凭据配置已变化')
  return describeMcpCredentialPrompt({ id: row.id, name: row.name, credentialSlots: row.credential_slots,
    configurationVersion: intent.configuration_version })
}
