import type { Pool } from 'pg'

type FeishuBot = { id: number; app_id: string; app_secret: string; owner_platform_user_id: string | null }

export async function readEnabledFeishuBot(pool: Pick<Pool, 'query'>, ownerId: string, botId?: number): Promise<FeishuBot | undefined> {
  return (await pool.query<FeishuBot>(`SELECT id,app_id,app_secret,owner_platform_user_id FROM user_bots
    WHERE user_id=$1 AND platform='feishu' AND enabled=TRUE
    ${botId === undefined ? 'ORDER BY id LIMIT 1' : 'AND id=$2'}`,
  botId === undefined ? [ownerId] : [ownerId, botId])).rows[0]
}
