import { createHmac } from 'node:crypto'
import { CoreError, createWorkspaceDeleter } from '@gugu/core'
import { createSessionFilesystemGrant } from '@gugu/core/agent/interactions/grant-filesystem'
import type { InteractionCommandActionInput, InteractionCommandActionResult } from '@gugu/core/agent/interactions/consume-action'
import type { SessionFilesystemGrantStore, SessionFilesystemGrantTransaction } from '@gugu/core/agent/interactions/grant-filesystem'
import type { PoolClient } from 'pg'
import { createPostgresWorkspaceDeletionTransaction } from '../../workspaces/persistence/workspace-delete.js'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function fingerprint(value: string, secretKey: string): string {
  return createHmac('sha256', secretKey).update(value, 'utf8').digest('hex')
}

/** Agent prompt 的命令副作用复用消费事务；事务提交前失败会连同 prompt/action 一起回滚。 */
export function createPostgresAgentInteractionCommandEffects(options: {
  filesystemAuthorizationEnabled(): boolean
  secretKey: string
  now?: () => Date
}) {
  if (typeof options.filesystemAuthorizationEnabled !== 'function' || !options.secretKey.trim()) throw new TypeError('交互命令副作用未完整配置')
  const now = options.now ?? (() => new Date())
  const grantFilesystem = (client: PoolClient) => {
    const store: SessionFilesystemGrantStore = {
      transaction<T>(work: (tx: SessionFilesystemGrantTransaction) => Promise<T>) {
        const tx: SessionFilesystemGrantTransaction = {
          async lockOwnedSession(ownerId, sessionId) {
            const result = await client.query('SELECT id FROM conversation_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [sessionId, ownerId])
            return !!result.rows[0]
          },
          async hasActiveGrant(ownerId, sessionId, at) {
            const result = await client.query(`SELECT id FROM filesystem_authorization_grants
              WHERE user_id=$1 AND subject_type='session' AND subject_id=$2 AND scope='user_sandbox'
                AND permission='read_write' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$3)
              ORDER BY id DESC LIMIT 1 FOR UPDATE`, [ownerId, String(sessionId), at])
            return !!result.rows[0]
          },
          async insertGrant(ownerId, sessionId, grantedBy, at) {
            const result = await client.query<{ id: number }>(`INSERT INTO filesystem_authorization_grants
              (user_id,subject_type,subject_id,scope,permission,granted_by,granted_at,expires_at,revoked_at,created_at,updated_at)
              VALUES($1,'session',$2,'user_sandbox','read_write',$3,$4,NULL,NULL,$4,$4) RETURNING id`, [ownerId, String(sessionId), grantedBy, at])
            const grantId = result.rows[0]?.id
            if (!Number.isSafeInteger(grantId) || Number(grantId) < 1) throw new Error('文件系统授权记录创建失败')
            return Number(grantId)
          },
          async recordGrant(ownerId, sessionId, grantId, grantedBy, at) {
            const metadata = { subject_type: 'session', subject_id: String(sessionId), scope: 'user_sandbox', operation: 'authorization', outcome: 'granted', source: grantedBy, grant_id: String(grantId) }
            await client.query(`INSERT INTO security_events
              (user_id,event_type,resource_type,resource_fingerprint,owner_fingerprint,client_fingerprint,ip_fingerprint,user_agent_fingerprint,action,reason_code,metadata_json,occurred_at,expires_at)
              VALUES($1,'filesystem.authorization','filesystem:session',$2,NULL,NULL,NULL,NULL,'logged','granted',$3::jsonb,$4::timestamptz,$4::timestamptz+interval '90 days')`,
            [ownerId, fingerprint(String(sessionId), options.secretKey), JSON.stringify(metadata), at])
          },
        }
        return work(tx)
      },
    }
    return createSessionFilesystemGrant({ enabled: options.filesystemAuthorizationEnabled, now, store })
  }

  return {
    async applyCommandAction(client: PoolClient, input: InteractionCommandActionInput): Promise<InteractionCommandActionResult> {
      if (input.commandAction === 'workspace_delete') {
        const rawId = record(input.context).workspace_id
        const workspaceId = typeof rawId === 'number' ? rawId : typeof rawId === 'string' && /^\d+$/.test(rawId) ? Number(rawId) : NaN
        if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) return { status: 'error', text: '工作区不存在，或已经被删除。' }
        const selected = await client.query<{ id: number; name: string }>(
          'SELECT id,name FROM workspaces WHERE id=$1 AND user_id=$2 FOR UPDATE', [workspaceId, input.ownerId],
        )
        const workspace = selected.rows[0]
        if (!workspace) return { status: 'error', text: '工作区不存在，或已经被删除。' }
        try {
          await createWorkspaceDeleter({ transaction: work => work(createPostgresWorkspaceDeletionTransaction(client)) })(input.ownerId, workspaceId)
        } catch (error) {
          if (error instanceof CoreError && error.code === 'not_found') return { status: 'error', text: '工作区不存在，或已经被删除。' }
          throw error
        }
        return { status: 'confirmed', text: `已删除工作区「${workspace.name}」（ID ${workspace.id}），项目和文件未受影响。` }
      }

      try {
        return await grantFilesystem(client)({
          ownerId: input.ownerId,
          sessionId: input.sessionId,
          grantedBy: input.toolName === 'ask_user' ? 'askuser' : 'user',
        })
      } catch (error) {
        if (error instanceof CoreError && (error.code === 'not_found' || error.code === 'conflict')) return { status: 'error', text: error.message }
        throw error
      }
    },
  }
}
