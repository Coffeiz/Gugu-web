import type { PoolClient } from 'pg'
import type { PendingInteraction, RunIdentity } from '@gugu/core/agent'
import { targetConfirmationIdentity, type ConfirmationContext, type ConfirmationTargetId } from '../tools/confirmation-identity.js'
import type { AgentPromptSpec } from '@gugu/core/agent'
import type { ConfirmationIntent, ConfirmationTargetSnapshot } from '@gugu/core/tools'

export type TrustedPromptIntent = {
  kind: 'confirmation'; summary: string; action: string; targets: Readonly<Record<string, readonly ConfirmationTargetId[]>>; context?: ConfirmationContext; ttlMinutes: number
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
      return { kind: 'confirm', title: '请确认操作', body: intent.summary, options: [
        { id: 'confirm', label: '确认', actionType: 'confirm' }, { id: 'cancel', label: '取消', actionType: 'cancel' },
      ], context: { confirm_code: code }, expiresMinutes: intent.ttlMinutes }
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
      const slots: unknown[] = Array.isArray(server.credential_slots) ? server.credential_slots : []
      const fields = slots.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('凭据槽位无效')
        const slot = value as Record<string, unknown>, name = slot.id, label = slot.label
        if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || typeof label !== 'string' || !label.trim() || label.length > 120) throw new Error('凭据槽位无效')
        return { name, label: label.trim(), type: 'secret' as const }
      })
      if (!fields.length || fields.length > 16 || new Set(fields.map(field => field.name)).size !== fields.length) throw new Error('凭据槽位无效')
      return { kind: 'form', title: '补全 MCP 凭据', body: `MCP 服务 [${String(server.name).slice(0, 64)}] 需要凭据，值只会加密保存。`, options: [],
        secretFields: fields, context: { secret_target: { kind: 'mcp_credentials', server_id: intent.serverId,
          ...(intent.configurationVersion ? { configuration_version: intent.configurationVersion } : {}) } } }
    },
  }
}
