import type { Pool } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import type { ImActorInput } from '@gugu/core/im/access'
import { parseImAttentionRecord } from '@gugu/core/im/attention/directive'

/** 冻结的自动回复只在相同当前策略下有效；不替代actor、工具或平台投递权限。 */
export function createPostgresImAttentionPolicyGuard(options: { pool: Pick<Pool,'query'>; identity: RunIdentity; input: ImActorInput; record: unknown }) {
  if(options.record===undefined)return async()=>true // 旧普通/明确@运行没有自动回复策略快照。
  const frozen=parseImAttentionRecord(options.record),identity={...options.identity},input=structuredClone(options.input)
  if(frozen.disposition!=='run'||input.ownerId!==identity.ownerId||input.chatType!=='group'||!input.chatId
    ||!['qq','feishu','telegram'].includes(input.platform)||!/^[1-9]\d*$/u.test(input.botId)
    ||!Number.isSafeInteger(Number(input.botId))||Number(input.botId)>2147483647
    ||!/^[1-9]\d*$/u.test(identity.sessionId)||!Number.isSafeInteger(Number(identity.sessionId))||Number(identity.sessionId)>2147483647)
    throw new Error('IM 自动回复策略范围无效')
  return async():Promise<boolean>=>{
    try{
      const result=await options.pool.query(`SELECT b.group_requires_at,b.group_read_enabled,b.group_attention_mode,b.group_attention_config_version
        FROM user_bots b JOIN users u ON u.id=b.user_id
        JOIN conversation_sessions s ON s.user_id=b.user_id AND s.source=b.platform AND s.bot_id=b.id::text
        WHERE b.user_id=$1 AND b.id=$2::integer AND b.platform=$3 AND b.enabled IS TRUE
          AND u.is_active IS TRUE AND COALESCE(u.account_status,'active')='active'
          AND (CASE WHEN b.platform='feishu' THEN b.feishu_group_chat_enabled IS DISTINCT FROM FALSE
            WHEN b.platform IN ('qq','telegram') THEN b.group_chat_enabled IS TRUE ELSE FALSE END)
          AND s.id=$4::integer AND s.chat_type='group' AND s.chat_id=$5`,
      [identity.ownerId,input.botId,input.platform,identity.sessionId,input.chatId])
      const row=result.rows[0]
      if(result.rows.length!==1||!row||row.group_requires_at!==false||row.group_read_enabled!==false
        ||!Number.isSafeInteger(row.group_attention_config_version)||row.group_attention_config_version!==frozen.configVersion)return false
      const mode=['quiet','natural','active','autonomous'].includes(row.group_attention_mode)?row.group_attention_mode:'autonomous'
      return mode===frozen.mode
    }catch{throw new Error('IM 自动回复策略暂时不可用')} // 存储故障保留运行重试，不能冒充真实撤权而永久取消。
  }
}
