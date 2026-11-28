import { createHash } from 'node:crypto'
import { notifyGroupDisabled } from '@gugu/gateway'
import type { Pool } from 'pg'
import type { TrustedGatewayBot } from './bot-config.js'

const eligible = `b.user_id=$1 AND b.id=$2::integer AND b.platform=$3
  AND b.enabled IS TRUE AND b.owner_platform_user_id IS NOT NULL
  AND u.is_active IS TRUE AND COALESCE(u.account_status,'active')='active'
  AND (CASE WHEN b.platform='feishu' THEN b.feishu_group_chat_enabled IS FALSE
    ELSE b.group_chat_enabled IS NOT TRUE END)`

export function createPostgresGroupDisabledNotice(pool: Pick<Pool, 'query'>,
  isCurrent: (bot: TrustedGatewayBot) => Promise<boolean>) {
  return async (bot: TrustedGatewayBot, group: string, signal: AbortSignal,
    send: Parameters<typeof notifyGroupDisabled>[0]['send']): Promise<boolean> => {
    const scope = [bot.owner, bot.id, bot.platform]
    const read = () => pool.query<{ group_disabled_epoch: string }>(`SELECT b.group_disabled_epoch
      FROM user_bots b JOIN users u ON u.id=b.user_id WHERE ${eligible}`, scope)
    const epoch = (await read()).rows[0]?.group_disabled_epoch
    if (!epoch) return false
    const groupKey = createHash('sha256').update(group).digest('hex')
    await notifyGroupDisabled({
      mentioned: true,
      authorize: async () => !signal.aborted && await isCurrent(bot)
        && (await read()).rows[0]?.group_disabled_epoch === epoch && !signal.aborted,
      send,
      store: { async claim() {
        const result = await pool.query(`INSERT INTO im_group_disabled_notices (bot_id, group_id, epoch)
          SELECT b.id, $4, b.group_disabled_epoch FROM user_bots b JOIN users u ON u.id=b.user_id
          WHERE ${eligible} AND b.group_disabled_epoch=$5 ON CONFLICT DO NOTHING`, [...scope, groupKey, epoch])
        if (!result.rowCount) return
        return async () => {
          await pool.query(`DELETE FROM im_group_disabled_notices n USING user_bots b
            WHERE n.bot_id=b.id AND b.user_id=$1 AND b.id=$2::integer AND b.platform=$3
              AND n.group_id=$4 AND n.epoch=$5`, [...scope, groupKey, epoch])
        }
      } },
    })
    return true
  }
}
