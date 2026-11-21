import type { PoolClient } from 'pg'
import type { ImPreflightScope } from '@gugu/gateway'

/** receipt+真实user锚点绑定平台/Bot/聊天与发起speaker；不能用owner或群session末次speaker代替。 */
export const imInteractionScopeSql = `FROM interaction_prompts p JOIN agent_interaction_bindings b
  ON b.prompt_id=p.id AND b.user_id=p.user_id AND b.session_id=p.session_id
  JOIN gugu_im_inbound_receipts r ON r.user_id=b.user_id AND r.session_id=b.session_id AND r.run_id=b.run_id AND r.state='dispatched'
  JOIN conversation_messages m ON m.id=r.message_id AND m.session_id=r.session_id AND m.run_id=b.run_id AND m.role='user'
  JOIN conversation_sessions s ON s.id=p.session_id AND s.user_id=p.user_id
  JOIN user_bots bot ON bot.id::text=r.bot_id AND bot.user_id=r.user_id AND bot.platform=r.platform AND bot.enabled IS TRUE
  JOIN users u ON u.id=p.user_id AND u.is_active IS TRUE AND COALESCE(u.account_status,'active')='active'
  WHERE p.user_id=$1 AND r.platform=$2 AND r.bot_id=$3 AND r.chat_type=$4 AND m.chat_type=$4 AND m.platform_user_id=$5
    AND (($4='group' AND s.source=$2 AND s.bot_id=$3 AND s.chat_type='group' AND s.chat_id=$6)
      OR ($4='c2c' AND s.chat_id IS NULL AND (s.chat_type='c2c' OR s.chat_type IS NULL)
        AND ((s.source=$2 AND s.bot_id=$3 AND s.platform_user_id=$5) OR s.source='web')))`
export function imInteractionScopeParameters(scope: ImPreflightScope): unknown[] {
  return [scope.ownerId, scope.platform, scope.botId, scope.chatType, scope.platformUserId, scope.chatId]
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
/** 只消费普通交互的已提交事件；秘密事件由专用stage收据确认。 */
export async function imOrdinaryInteractionReplayed(client: PoolClient, scope: ImPreflightScope): Promise<boolean> {
  if (!scope.eventId) return false
  const result = await client.query<{ schema_json: unknown }>(`SELECT p.schema_json ${imInteractionScopeSql}
    AND (EXISTS (SELECT 1 FROM interaction_actions a WHERE a.prompt_id=p.id AND a.status='consumed' AND a.consumed_event_id=$7)
      OR p.schema_json::jsonb->>'node_text_consumed_event_id'=$7)`, [...imInteractionScopeParameters(scope), scope.eventId])
  return result.rows.some(row => {
    const schema = object(row.schema_json), target = object(object(schema.context).secret_target)
    return !(Array.isArray(schema.secret_fields) && schema.secret_fields.length > 0 && target.kind === 'mcp_credentials')
  })
}
