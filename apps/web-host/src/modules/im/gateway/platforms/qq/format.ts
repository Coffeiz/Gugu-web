import type { Pool } from 'pg'
import type { NodeImBotBinding } from '../../inbound/inbox.js'

/** 只有明确缺省值沿旧默认；非空坏配置不能变成模型可控格式。 */
export async function readTrustedQqReplySettings(pool: Pick<Pool, 'query'>, binding: NodeImBotBinding, chatType: 'group' | 'c2c'): Promise<{messageFormat:'compat'|'markdown';privateStreaming:boolean}> {
  try {
    const row = (await pool.query(`SELECT group_message_format,private_message_format,private_streaming_enabled FROM user_bots
      WHERE user_id=$1 AND id=$2 AND platform='qq' AND enabled IS TRUE`, [binding.ownerId, binding.botId])).rows[0]
    if (!row || binding.platform !== 'qq') throw new Error()
    const value = chatType === 'group' ? row.group_message_format : row.private_message_format
    if (value !== null && value !== undefined && value !== 'compat' && value !== 'markdown') throw new Error()
    const enabled=row.private_streaming_enabled
    if(enabled!==null&&enabled!==undefined&&typeof enabled!=='boolean')throw new Error()
    return {messageFormat:value ?? (chatType === 'group' ? 'compat' : 'markdown'),privateStreaming:enabled===true}
  } catch { throw new Error('IM 运行回复装配不可用') }
}

export async function readTrustedQqMessageFormat(pool: Pick<Pool,'query'>,binding:NodeImBotBinding,chatType:'group'|'c2c'):Promise<'compat'|'markdown'> {
  return (await readTrustedQqReplySettings(pool,binding,chatType)).messageFormat
}
