import type { PoolClient } from 'pg'
import type { PendingInteraction, RunIdentity } from '@gugu/core/agent'
import { targetConfirmationIdentity, type ConfirmationContext, type ConfirmationTargetId } from '../tools/identity.js'
import { describeMcpCredentialPrompt, type AgentPromptSpec } from '@gugu/core/agent'
import type { ConfirmationIntent, ConfirmationTargetSnapshot } from '@gugu/core/tools'
import { readActiveSessionFilesystemGrant } from '../sandbox/authorization.js'

export type TrustedPromptIntent = {
  kind: 'confirmation'; summary: string; action: string; targets: Readonly<Record<string, readonly ConfirmationTargetId[]>>; context?: ConfirmationContext; emailCompose?: Readonly<Record<string, unknown>>; ttlMinutes: number
  /** 可供事务确认协议恢复的可信意图和领域目标；不来自模型输入。 */
  operation?: { intent: ConfirmationIntent; snapshot: ConfirmationTargetSnapshot }
} | { kind: 'credential'; serverId: string; action: string; configurationVersion?: string }

/** 使用数据库规范 JSON 绑定地址、槽位及已有密文，避免连接时区影响摘要。 */
export const mcpCredentialConfigurationVersionSql =
  "encode(sha256(convert_to((to_jsonb(server)-'created_at'-'updated_at')::text,'UTF8')),'hex')"
export interface TrustedPromptPorts {
  /** 必须由可信工具执行层写入并按 owner/session/run/interaction 读取，不能查询模型参数。 */
  loadIntent(client: PoolClient, identity: RunIdentity, request: PendingInteraction): Promise<TrustedPromptIntent | null>
  createConfirmation(ownerId: string, summary: string, targetIdentity: string, ttlMinutes: number): Promise<string | null>
  filesystemAuthorizationEnabled(): boolean
}
function checkedIntent(intent: TrustedPromptIntent | null, kind: TrustedPromptIntent['kind']): asserts intent is TrustedPromptIntent {
  if (!intent || intent.kind !== kind) throw new Error('可信交互上下文不存在')
}
/** 仅以服务端工具结果和 owner 受限 MCP 行构造确认及凭据描述。 */
export function createTrustedPromptDescriptions(ports: TrustedPromptPorts) {
  return {
    async confirmation(client: PoolClient, identity: RunIdentity, request: PendingInteraction): Promise<AgentPromptSpec> {
      const intent = await ports.loadIntent(client, identity, request)
      checkedIntent(intent, 'confirmation')
      if (intent.kind !== 'confirmation' || !intent.summary.trim() || intent.summary.length > 1000 || !Number.isSafeInteger(intent.ttlMinutes) || intent.ttlMinutes < 1 || intent.ttlMinutes > 30) throw new Error('确认上下文无效')
      const operation = intent.operation
      // 空级联集合仍由摘要绑定；旧确认身份格式只接受非空目标类别。
      const targets = operation ? Object.fromEntries(Object.entries(intent.targets).filter(([, ids]) => ids.length > 0)) : intent.targets
      const context = operation ? { ...intent.context, targets_digest: operation.intent.targetsDigest, versions_digest: operation.intent.versionsDigest } : intent.context
      const targetIdentity = targetConfirmationIdentity(intent.action, targets, context)
      const code = await ports.createConfirmation(identity.ownerId, intent.summary, targetIdentity, intent.ttlMinutes)
      if (!code) throw new Error('确认服务暂不可用')
      return { kind: 'confirm', title: intent.emailCompose ? '编辑邮件' : '请确认操作', body: intent.summary, options: [
        { id: 'confirm', label: '确认', actionType: 'confirm' }, { id: 'cancel', label: '取消', actionType: 'cancel' },
      ], context: { confirm_code: code, ...(intent.action === 'send_email' && intent.emailCompose ? { email_compose: intent.emailCompose } : {}) }, expiresMinutes: intent.ttlMinutes }
    },
    async credential(client: PoolClient, identity: RunIdentity, request: PendingInteraction): Promise<AgentPromptSpec> {
      const intent = await ports.loadIntent(client, identity, request)
      checkedIntent(intent, 'credential')
      if (intent.kind !== 'credential' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(intent.serverId)) throw new Error('凭据交互目标无效')
      const found = await client.query(`SELECT id,name,credential_slots,${mcpCredentialConfigurationVersionSql} AS configuration_version
        FROM user_mcp_servers server WHERE id=$1 AND user_id=$2 AND scope=$3 FOR UPDATE`, [intent.serverId, identity.ownerId, 'user'])
      const server = found.rows[0]
      if (!server) throw new Error('MCP server 不存在')
      if (intent.configurationVersion !== undefined && (request.toolCall.name !== 'manage_mcp_servers' || !/^[a-f0-9]{64}$/u.test(intent.configurationVersion)
        || server.configuration_version !== intent.configurationVersion)) throw new Error('MCP 凭据配置已变化')
      return describeMcpCredentialPrompt({
        id: intent.serverId, name: server.name, credentialSlots: server.credential_slots,
        configurationVersion: intent.configurationVersion,
      })
    },
    async authorization(client: PoolClient, identity: RunIdentity): Promise<AgentPromptSpec> {
      if (!ports.filesystemAuthorizationEnabled()) throw new Error('完整用户沙箱授权功能当前未开启')
      const sessionId = Number(identity.sessionId)
      if (!Number.isSafeInteger(sessionId) || sessionId <= 0) throw new Error('会话授权目标无效')
      const session = await client.query('SELECT id FROM conversation_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [sessionId, identity.ownerId])
      if (!session.rows[0]) throw new Error('会话不存在')
      const grant = await readActiveSessionFilesystemGrant(client, identity.ownerId, sessionId, new Date(), true)
      if (grant) throw new Error('当前会话已获得完整用户沙箱权限')
      return { kind: 'choice', title: '确认授权完整用户沙箱权限？',
        body: '授权后，当前会话中的 Shell 可读写完整用户沙箱内的 workspace、personal 和 project。不会授权宿主机、其他用户目录或 Docker 权限；可使用 /workspace revoke 撤销。',
        options: [{ id: 'confirm', label: '授权', actionType: 'choice' }, { id: 'cancel', label: '取消', actionType: 'cancel' }],
        context: { command_action: 'filesystem_authorization_grant' }, allowTextInput: false }
    },
  }
}
