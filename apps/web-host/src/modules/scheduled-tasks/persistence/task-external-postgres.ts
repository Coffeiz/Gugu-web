import { createHmac } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { TaskExternalResolution } from './task-resolver-postgres.js'

type Row = Record<string, any>
const platforms = ['qq', 'feishu', 'telegram'] as const
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
export interface TaskExternalOptions {
  secretKey: string
  readWechatPrivate(owner: string): Promise<Row | null>
  revokeConfirmation(owner: string, summary: string, identity: string): Promise<void>
}

export function createPostgresTaskExternal(options: TaskExternalOptions): TaskExternalResolution {
  return {
    async resolveDelivery(client, owner, input, previous) {
      const selected: string[] = Array.isArray(input.channels) ? input.channels : previous?.channels?.split(',').filter(Boolean) ?? ['web']
      const targets: Row = {}, old = object(previous?.delivery_targets)
      const configs = { ...object(input.im_delivery) }
      if (!configs.qq && input.qq_delivery && typeof input.qq_delivery === 'object') configs.qq = input.qq_delivery
      for (const platform of [...platforms, 'wechat'] as const) {
        const enabled = selected.includes(platform)
        let bot: Row | undefined
        if (enabled) bot = (await client.query<Row>(`SELECT id,owner_platform_user_id FROM user_bots WHERE user_id=$1 AND platform=$2 AND enabled=TRUE ORDER BY id LIMIT 1`, [owner, platform])).rows[0]
        if (platform === 'wechat') {
          if (enabled) {
            const reach = await options.readWechatPrivate(owner)
            if (bot && reach && String(reach.channel_id) === String(bot.id) && reach.puid && reach.context_token)
              targets[platform] = { platform, chat_type: 'c2c', chat_id: null, puid: reach.puid, channel_id: reach.channel_id }
          }
          continue
        }
        if (enabled) targets[platform] = { platform, chat_type: 'c2c', chat_id: null, puid: bot?.owner_platform_user_id ?? null, channel_id: bot ? String(bot.id) : null }
        const config = object(configs[platform])
        if (enabled && configs[platform] && config.mode === 'private') {
          if (platform !== 'qq' && !bot?.owner_platform_user_id) throw new TypeError(`${platform} 尚无可用私聊目标，请先与 Bot 私聊`)
        } else if (enabled && configs[platform] && config.mode === 'group') {
          const chatId = String(config.chat_id ?? '').trim()
          if (!chatId) throw new TypeError('群投递需要 chat_id')
          if (!bot) throw new TypeError(`${platform} Bot 未连接或已停用`)
          const session = await client.query(`SELECT id FROM conversation_sessions WHERE user_id=$1 AND source=$2 AND chat_type='group' AND chat_id=$3 AND bot_id=$4 ORDER BY id DESC LIMIT 1`, [owner, platform, chatId, String(bot.id)])
          if (!session.rowCount) throw new TypeError('找不到该群会话，请先让咕咕在群里收到一条消息')
          targets[platform] = { platform, chat_type: 'group', chat_id: chatId, puid: bot.owner_platform_user_id, channel_id: String(bot.id) }
        } else if (enabled && configs[platform]) throw new TypeError('投递目标 mode 只能是 private 或 group')
        else if (old[platform]) targets[platform] = old[platform]
      }
      const active = Object.entries(targets).filter(([channel]) => selected.includes('im') || selected.includes(channel))
      if (active.filter(([, value]) => object(value).chat_type === 'group' && object(value).chat_id).length > 1) throw new TypeError('一个定时任务目前只能设置一个群聊投递目标')
      return Object.keys(targets).length ? targets : null
    },
    async revokeFilesystem(client, owner, task) {
      await options.revokeConfirmation(owner, `允许定时任务「${task.name}」读写整个用户沙箱（包含 /workspace、/personal、/project）`, `scheduled-task:filesystem:${task.id}`)
      const grantId = task.filesystem_authorization_grant_id
      await client.query('UPDATE scheduled_tasks SET filesystem_authorization_grant_id=NULL WHERE id=$1 AND user_id=$2', [task.id, owner])
      const result = await client.query(`UPDATE filesystem_authorization_grants SET revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id`, [grantId, owner])
      if (!result.rowCount) return
      const metadata = { subject_type: 'scheduled_task', subject_id: String(task.id), grant_id: String(grantId), scope: 'user_sandbox', operation: 'authorization', outcome: 'revoked', source: 'system' }
      const fingerprint = createHmac('sha256', options.secretKey).update(String(task.id)).digest('hex')
      await client.query(`INSERT INTO security_events(user_id,event_type,resource_type,resource_fingerprint,owner_fingerprint,client_fingerprint,ip_fingerprint,user_agent_fingerprint,action,reason_code,metadata_json,occurred_at,expires_at) VALUES($1,'filesystem.authorization','filesystem:scheduled_task',$2,NULL,NULL,NULL,NULL,'logged','revoked',$3::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '90 days')`, [owner, fingerprint, JSON.stringify(metadata)])
    },
  }
}
