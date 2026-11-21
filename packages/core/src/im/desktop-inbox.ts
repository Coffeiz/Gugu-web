import { claimDesktopChatAttachments, stageDesktopChatAttachment, type DesktopChatAttachmentInput } from '../agent/attachments/desktop-store.js'
import type { RunIdentity } from '../agent/models.js'
import { createHash } from 'node:crypto'
import { createDesktopAgentSession } from '../agent/sessions/desktop.js'
import { sql, type Kysely, type Transaction } from 'kysely'
import { CoreError, type Fields } from '../contracts/index.js'
import { databaseTime, nowUtc } from '../data/codec.js'
import type { Database } from '../data/schema.js'

function connectionScope(fields: Fields) {
  const { platform, connectionId } = fields
  if (typeof platform !== 'string' || !['feishu', 'qq', 'wechat', 'telegram'].includes(platform)
    || typeof connectionId !== 'string' || !/^[a-f0-9]{64}$/.test(connectionId))
    throw new CoreError('invalid_request', '本机 IM 连接范围无效')
  return { platform, connectionId }
}

function imClientId(platform: string, connectionId: string, eventKey: string) {
  return createHash('sha256').update(JSON.stringify([platform, connectionId, eventKey])).digest('hex')
}

export async function admitDesktopImEvent(db: Kysely<Database>, ownerId: string, fields: Fields): Promise<null | boolean> {
  const owner = ownerId.toLowerCase().replaceAll('-', '')
  const { platform, connectionId } = connectionScope(fields)
  const { eventKey, sealedEvent } = fields
  if (typeof eventKey !== 'string' || !eventKey || eventKey.length > 512
    || typeof sealedEvent !== 'string' || sealedEvent.length > 48_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(sealedEvent))
    throw new CoreError('invalid_request', '本机 IM 收件格式无效')
  const sealed = Buffer.from(sealedEvent, 'base64')
  if (sealed.toString('base64') !== sealedEvent) throw new CoreError('invalid_request', '本机 IM 收件密文无效')
  const { attachments } = fields
  if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 32
    || attachments.some(input => !input || typeof input !== 'object' || Array.isArray(input))))
    throw new CoreError('invalid_request', '本机 IM 附件格式无效')
  return db.transaction().execute(async tx => {
    const recorded = await sql`SELECT 1 FROM desktop_im_sessions im JOIN conversation_messages m ON m.session_id=im.session_id
      WHERE im.owner_id=${owner} AND im.platform=${platform} AND im.connection_id=${connectionId}
        AND m.client_message_id=${imClientId(platform, connectionId, eventKey)}`.execute(tx)
    if (recorded.rows.length) return attachments === undefined ? null : false
    const inserted = await sql`INSERT INTO desktop_im_inbox (owner_id, platform, connection_id, event_key, sealed_event, received_at)
      VALUES (${owner}, ${platform}, ${connectionId}, ${eventKey}, ${sealed}, ${new Date().toISOString()})
      ON CONFLICT(owner_id, platform, connection_id, event_key) DO NOTHING RETURNING event_key`.execute(tx)
    if (attachments === undefined) return null
    if (!inserted.rows.length) return false
    for (const input of attachments) {
      const file = input as DesktopChatAttachmentInput & { sourceIndex?: number }
      const sourceMessageId = fields.sourceMessageId
      const source = platform === 'telegram' && typeof sourceMessageId === 'string' && sourceMessageId.length <= 256
        && /^[0-9]+:-?[0-9]+:[0-9]+$/u.test(sourceMessageId)
        && typeof file.sourceIndex === 'number' && Number.isInteger(file.sourceIndex) && file.sourceIndex >= 0 && file.sourceIndex < 32
        ? { sourceMessageId, sourceIndex: file.sourceIndex, eventKey } : {}
      await stageDesktopChatAttachment(tx, ownerId, file, { platform, connectionId, clientId: imClientId(platform, connectionId, eventKey), ...source })
    }
    return true
  })
}

export async function desktopQqGroupRunEvent(db: Kysely<Database>, identity: RunIdentity) {
  const owner = identity.ownerId.toLowerCase().replaceAll('-', '')
  const session = Number(identity.sessionId)
  const { rows } = await sql<{ connection_id: string; client_message_id: string; event_key: string; sealed_event: Buffer }>`
    SELECT im.connection_id,m.client_message_id,i.event_key,i.sealed_event
    FROM agent_run_admissions a
    JOIN conversation_sessions s ON s.id=a.session_id AND s.user_id=a.user_id
      AND s.active_run_id=a.run_id AND s.chat_type='group'
    JOIN conversation_messages m ON m.id=a.user_message_id AND m.session_id=s.id
    JOIN desktop_im_sessions im ON im.session_id=s.id AND im.owner_id=s.user_id AND im.platform='qq'
    JOIN desktop_im_inbox i ON i.owner_id=im.owner_id AND i.platform=im.platform AND i.connection_id=im.connection_id
    WHERE a.user_id=${owner} AND a.session_id=${session} AND a.run_id=${identity.runId}
      AND (i.run_id=a.run_id OR i.run_id IS NULL AND i.state='pending')
    ORDER BY (i.run_id IS NULL),i.received_at,i.rowid LIMIT 1`.execute(db)
  // 尚未回填 run_id 时，调度器只能从同一连接的队首启动运行。
  const match = rows[0]
  return match && imClientId('qq', match.connection_id, match.event_key) === match.client_message_id ? { connectionId: match.connection_id, eventKey: match.event_key, sealedEvent: match.sealed_event.toString('base64') } : null
}

/** 每次只返回一个连接的收件密文，供宿主重新核对当前绑定。 */
export async function readPendingDesktopImConnection(db: Kysely<Database>, ownerId: string, fields: Fields) {
  const owner = ownerId.toLowerCase().replaceAll('-', '')
  const platform = fields.platform
  const after = fields.after ?? ''
  if (platform !== 'qq' || typeof after !== 'string' || (after !== '' && !/^[0-9a-f]{64}$/u.test(after)))
    throw new CoreError('invalid_request', '本机 IM 恢复游标无效')
  const { rows } = await sql<{ connection_id: string; event_key: string; sealed_event: Buffer }>`
    SELECT connection_id,event_key,sealed_event FROM desktop_im_inbox
    WHERE owner_id=${owner} AND platform=${platform} AND connection_id>${after} AND state IN ('pending','running')
    ORDER BY connection_id, received_at, rowid LIMIT 1`.execute(db)
  const row = rows[0]
  return row ? { connectionId: row.connection_id, eventKey: row.event_key, sealedEvent: row.sealed_event.toString('base64') } : null
}

async function ensureDesktopImSession(tx: Transaction<Database>, ownerId: string, owner: string,
  platform: string, connectionId: string, chatType: 'c2c' | 'group', ownerPlatformUserId: unknown) {
  if (ownerPlatformUserId !== undefined && (platform !== 'qq' || chatType !== 'group'
    || typeof ownerPlatformUserId !== 'string' || !ownerPlatformUserId.trim() || ownerPlatformUserId.length > 256))
    throw new CoreError('invalid_request', '本机 IM 群身份无效')
  const mapped = (await sql<{ session_id: number; chat_type: string | null; platform_user_id: string | null }>`
    SELECT im.session_id,s.chat_type,s.platform_user_id FROM desktop_im_sessions im
    JOIN conversation_sessions s ON s.id=im.session_id AND s.user_id=im.owner_id
    WHERE im.owner_id=${owner} AND im.platform=${platform} AND im.connection_id=${connectionId}`.execute(tx)).rows[0]
  if (mapped && (mapped.chat_type ?? 'c2c') !== chatType)
    throw new CoreError('conflict', '本机 IM 收件与会话类型不匹配')
  let sessionId = mapped?.session_id
  if (sessionId === undefined) {
    sessionId = (await createDesktopAgentSession(tx, ownerId, '即时通讯')).id
    await sql`UPDATE conversation_sessions SET chat_type=${chatType} WHERE id=${sessionId} AND user_id=${owner}`.execute(tx)
    await sql`INSERT INTO desktop_im_sessions (owner_id,platform,connection_id,session_id)
      VALUES (${owner},${platform},${connectionId},${sessionId})`.execute(tx)
  }
  if (typeof ownerPlatformUserId === 'string') {
    if (mapped?.platform_user_id && mapped.platform_user_id !== ownerPlatformUserId)
      throw new CoreError('conflict', '本机 IM 群身份不匹配')
    if (!mapped?.platform_user_id)
      await sql`UPDATE conversation_sessions SET platform_user_id=${ownerPlatformUserId}
        WHERE id=${sessionId} AND user_id=${owner}`.execute(tx)
  }
  return sessionId
}

/** 只写群会话历史，不启动 Agent，也不创建出站投递任务。 */
export function recordDesktopImGroupMessage(db: Kysely<Database>, ownerId: string, fields: Fields) {
  const owner = ownerId.toLowerCase().replaceAll('-', '')
  const { platform, connectionId } = connectionScope(fields)
  const { eventKey, text, attachments = [], platformUserId, platformUserName } = fields
  if (platform !== 'qq' || typeof eventKey !== 'string' || !/^[a-f0-9]{64}$/u.test(eventKey)
    || typeof text !== 'string' || text.length > 32_000
    || !Array.isArray(attachments) || attachments.length > 32
    || attachments.some(input => !input || typeof input !== 'object' || Array.isArray(input))
    || (!text.trim() && !attachments.length)
    || (platformUserId !== undefined && (typeof platformUserId !== 'string' || !platformUserId.trim() || platformUserId.length > 256))
    || (platformUserName !== undefined && (typeof platformUserName !== 'string' || platformUserName.length > 256)))
    throw new CoreError('invalid_request', '本机 IM 群记录无效')
  return db.transaction().execute(async tx => {
    const queued = await sql`SELECT 1 FROM desktop_im_inbox
      WHERE owner_id=${owner} AND platform=${platform} AND connection_id=${connectionId} AND event_key=${eventKey}`.execute(tx)
    if (queued.rows.length) return false
    const sessionId = await ensureDesktopImSession(tx, ownerId, owner, platform, connectionId, 'group', fields.ownerPlatformUserId)
    const clientId = imClientId(platform, connectionId, eventKey)
    const existing = await sql`SELECT 1 FROM conversation_messages
      WHERE session_id=${sessionId} AND client_message_id=${clientId}`.execute(tx)
    if (existing.rows.length) return false
    const at = databaseTime(nowUtc(), 'sqlite')
    const updated = await sql<{ last_message_seq: number }>`UPDATE conversation_sessions
      SET last_message_seq=last_message_seq+1,updated_at=${at} WHERE id=${sessionId} AND user_id=${owner}
      RETURNING last_message_seq`.execute(tx)
    const message = await sql<{ id: number }>`INSERT INTO conversation_messages(session_id,conversation_seq,role,content,client_message_id,created_at,platform_user_id,platform_user_name)
      VALUES(${sessionId},${updated.rows[0]!.last_message_seq},'user',${text},${clientId},${at},${platformUserId ?? null},${platformUserName ?? null}) RETURNING id`.execute(tx)
    const messageId = message.rows[0]!.id
    const ids: string[] = []
    for (const input of attachments) {
      const staged = await stageDesktopChatAttachment(tx, ownerId, input as DesktopChatAttachmentInput)
      ids.push(staged.attach_id)
    }
    if (ids.length) {
      const files = await claimDesktopChatAttachments(tx, ownerId, messageId, ids, sessionId, clientId)
      await sql`UPDATE conversation_messages SET files=${JSON.stringify(files)} WHERE id=${messageId} AND session_id=${sessionId}`.execute(tx)
    }
    return true
  })
}

/** 只准备已持久化的收件。重试继续使用同一连接会话与 Agent 消息标识。 */
export function prepareDesktopImEvent(db: Kysely<Database>, ownerId: string, fields: Fields) {
  const owner = ownerId.toLowerCase().replaceAll('-', '')
  const { platform, connectionId } = connectionScope(fields)
  const chatType = fields.chatType ?? 'c2c'
  if (chatType !== 'c2c' && chatType !== 'group')
    throw new CoreError('invalid_request', '本机 IM 会话类型无效')
  return db.transaction().execute(async tx => {
    const event = (await sql<{ event_key: string; sealed_event: Buffer; run_id: string | null; session_id: number | null }>`
      SELECT event_key, sealed_event, run_id, session_id FROM desktop_im_inbox
      WHERE owner_id=${owner} AND platform=${platform} AND connection_id=${connectionId}
        AND state IN ('pending','running')
      ORDER BY received_at, rowid LIMIT 1`.execute(tx)).rows[0]
    if (!event) return null
    const sessionId = await ensureDesktopImSession(tx, ownerId, owner, platform, connectionId, chatType, fields.ownerPlatformUserId)
    if (event.session_id !== null && event.session_id !== sessionId)
      throw new CoreError('conflict', '本机 IM 收件与会话不匹配')
    const clientId = imClientId(platform, connectionId, event.event_key)
    // Agent 准入已提交但收件还未登记运行时，按同一客户端消息标识找回原 Run。
    let runId = event.run_id
    if (!runId) {
      const admitted = (await sql<{ run_id: string }>`
        SELECT a.run_id FROM agent_run_admissions a
        JOIN conversation_messages m ON m.session_id=a.session_id AND m.id=a.user_message_id
        WHERE a.user_id=${owner} AND a.session_id=${sessionId} AND m.client_message_id=${clientId}`.execute(tx)).rows[0]
      if (admitted) {
        runId = admitted.run_id
        await sql`UPDATE desktop_im_inbox SET session_id=${sessionId}, run_id=${runId}, state='running'
          WHERE owner_id=${owner} AND platform=${platform} AND connection_id=${connectionId}
            AND event_key=${event.event_key} AND state='pending'`.execute(tx)
      }
    }
    return { sessionId, runId, eventKey: event.event_key,
      sealedEvent: event.sealed_event.toString('base64'), clientId }
  })
}

/** 首次发送前持久占位，重启后无法证明结果的投递按未知处理。 */
export function updateDesktopImDelivery(db: Kysely<Database>, ownerId: string, fields: Fields) {
  const owner = ownerId.toLowerCase().replaceAll('-', '')
  const { platform, connectionId } = connectionScope(fields)
  const { eventKey, runId, action, noticeKey } = fields
  if (typeof eventKey !== 'string' || !eventKey || typeof runId !== 'string' || !runId
    || (noticeKey !== undefined && (typeof noticeKey !== 'string' || !/^[a-f0-9]{64}$/.test(noticeKey)))
    || (action !== 'begin' && action !== 'accepted' && action !== 'rejected' && action !== 'unknown'))
    throw new CoreError('invalid_request', '本机 IM 投递状态无效')
  return db.transaction().execute(async tx => {
    const event = (await sql<{ state: string }>`
      SELECT state FROM desktop_im_inbox WHERE owner_id=${owner} AND platform=${platform}
        AND connection_id=${connectionId} AND event_key=${eventKey} AND run_id=${runId}`.execute(tx)).rows[0]
    if (!event || event.state !== 'running') return false
    if (noticeKey !== undefined) {
      if (action === 'begin') {
        const inserted = await sql`INSERT INTO desktop_im_notices (owner_id,platform,connection_id,event_key,notice_key,state)
          VALUES (${owner},${platform},${connectionId},${eventKey},${noticeKey},'sending')
          ON CONFLICT(owner_id,platform,connection_id,event_key,notice_key) DO NOTHING RETURNING state`.execute(tx)
        return inserted.rows.length === 1
      }
      const updated = await sql`UPDATE desktop_im_notices SET state=${action}
        WHERE owner_id=${owner} AND platform=${platform} AND connection_id=${connectionId} AND event_key=${eventKey}
          AND notice_key=${noticeKey} AND state='sending' RETURNING state`.execute(tx)
      return updated.rows.length === 1
    }
    if (action === 'begin') {
      const inserted = await sql`INSERT INTO desktop_im_delivery (owner_id,platform,connection_id,event_key,state)
        VALUES (${owner},${platform},${connectionId},${eventKey},'sending')
        ON CONFLICT(owner_id,platform,connection_id,event_key) DO NOTHING RETURNING state`.execute(tx)
      return inserted.rows.length === 1
    }
    const updated = await sql`UPDATE desktop_im_delivery SET state=${action}
      WHERE owner_id=${owner} AND platform=${platform} AND connection_id=${connectionId} AND event_key=${eventKey}
        AND state='sending' RETURNING state`.execute(tx)
    if (!updated.rows.length) return false
    await sql`UPDATE desktop_im_inbox SET state='completed' WHERE owner_id=${owner} AND platform=${platform}
      AND connection_id=${connectionId} AND event_key=${eventKey} AND run_id=${runId}`.execute(tx)
    return true
  })
}

/** 确认提示独立于最终回复登记，绑定收件与同一 Run 的持久提示。 */
export async function desktopImPrompt(db: Kysely<Database>, ownerId: string, fields: Fields) {
  const owner = ownerId.toLowerCase().replaceAll('-', '')
  const { platform, connectionId } = connectionScope(fields)
  const { action, promptId, messageId, eventKey, runId } = fields
  if (typeof promptId !== 'number' || !Number.isSafeInteger(promptId) || promptId <= 0)
    throw new CoreError('invalid_request', '本机 IM 提示标识无效')
  if (action === 'lookup') {
    if (!(platform === 'qq' && messageId === null)
      && (typeof messageId !== 'string' || !messageId || messageId.length > 512)) return null
    const result = await sql<{ sessionId: number; runId: string }>`
      SELECT i.session_id AS sessionId, i.run_id AS runId
      FROM desktop_im_prompts p JOIN desktop_im_inbox i USING (owner_id,platform,connection_id,event_key)
      WHERE p.owner_id=${owner} AND p.platform=${platform} AND p.connection_id=${connectionId}
        AND p.prompt_id=${promptId} AND p.state='accepted' AND (${messageId} IS NULL OR p.message_id=${messageId}) AND i.state='running'`.execute(db)
    return result.rows[0] ?? null
  }
  if (typeof eventKey !== 'string' || !eventKey || typeof runId !== 'string' || !runId)
    throw new CoreError('invalid_request', '本机 IM 提示运行无效')
  if (action === 'begin') {
    const result = await sql`INSERT INTO desktop_im_prompts (owner_id,platform,connection_id,event_key,prompt_id,state)
      SELECT i.owner_id,i.platform,i.connection_id,i.event_key,b.prompt_id,'sending'
      FROM desktop_im_inbox i JOIN agent_interaction_bindings b
        ON b.user_id=i.owner_id AND b.session_id=i.session_id AND b.run_id=i.run_id
      WHERE i.owner_id=${owner} AND i.platform=${platform} AND i.connection_id=${connectionId}
        AND i.event_key=${eventKey} AND i.run_id=${runId} AND i.state='running' AND b.prompt_id=${promptId}
      ON CONFLICT(owner_id,platform,connection_id,prompt_id) DO NOTHING RETURNING prompt_id`.execute(db)
    return result.rows.length === 1
  }
  if (action !== 'settle' || messageId !== null && (typeof messageId !== 'string' || !messageId || messageId.length > 512))
    throw new CoreError('invalid_request', '本机 IM 提示回执无效')
  const result = await sql`UPDATE desktop_im_prompts SET state=${messageId === null ? 'unknown' : 'accepted'}, message_id=${messageId}
    WHERE owner_id=${owner} AND platform=${platform} AND connection_id=${connectionId}
      AND event_key=${eventKey} AND prompt_id=${promptId} AND state='sending'
      AND EXISTS (SELECT 1 FROM desktop_im_inbox i WHERE i.owner_id=${owner} AND i.platform=${platform}
        AND i.connection_id=${connectionId} AND i.event_key=${eventKey} AND i.run_id=${runId} AND i.state='running')
    RETURNING prompt_id`.execute(db)
  return result.rows.length === 1
}

/** 仅拒绝尚未登记运行的无效收件，保留记录供排查。 */
export async function rejectDesktopImEvent(db: Kysely<Database>, ownerId: string, fields: Fields): Promise<boolean> {
  const owner = ownerId.toLowerCase().replaceAll('-', '')
  const { platform, connectionId } = connectionScope(fields)
  const { eventKey } = fields
  if (typeof eventKey !== 'string' || !eventKey || eventKey.length > 512)
    throw new CoreError('invalid_request', '本机 IM 事件标识无效')
  return db.transaction().execute(async tx => {
    const result = await sql`UPDATE desktop_im_inbox SET state='rejected'
      WHERE owner_id=${owner} AND platform=${platform} AND connection_id=${connectionId} AND event_key=${eventKey}
        AND state='pending' AND run_id IS NULL RETURNING event_key`.execute(tx)
    if (!result.rows.length) return false
    await sql`UPDATE chat_attachments SET extra=json_remove(extra,'$.im')
      WHERE user_id=${owner} AND state='draft'
        AND json_extract(extra,'$.im.clientId')=${imClientId(platform, connectionId, eventKey)}`.execute(tx)
    return true
  })
}

/** 密文由桌面宿主生成，收件范围与 Run 在同一事务内核对。 */
export function desktopImProjection(db: Kysely<Database>, ownerId: string, fields: Fields) {
  const owner = ownerId.toLowerCase().replaceAll('-', '')
  const { platform, connectionId } = connectionScope(fields)
  const { eventKey, runId, action, key, fingerprint, version, state, outcome } = fields
  const needsKey = action === 'begin' || action === 'settle' || action === 'accepted'
  const needsState = action === 'checkpoint' || action === 'accepted'
  if (typeof eventKey !== 'string' || !eventKey || typeof runId !== 'string' || !runId
    || typeof action !== 'string' || !['read', 'begin', 'settle', 'checkpoint', 'accepted'].includes(action)
    || (needsKey && (typeof key !== 'string' || !/^[\w:-]{1,160}$/.test(key)))
    || (action === 'begin' && (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)))
    || (action === 'settle' && outcome !== 'rejected' && outcome !== 'unknown')
    || (needsState && (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0
      || typeof state !== 'string' || !state || state.length > 1_450_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(state))))
    throw new CoreError('invalid_request', '本机 IM 流式投递状态无效')
  const sealed = needsState ? Buffer.from(state as string, 'base64') : null
  if (sealed && sealed.toString('base64') !== state)
    throw new CoreError('invalid_request', '本机 IM 流式投递密文无效')

  return db.transaction().execute(async tx => {
    const inboxScope = sql`owner_id=${owner} AND platform=${platform} AND connection_id=${connectionId} AND event_key=${eventKey}`
    const event = (await sql`SELECT 1 FROM desktop_im_inbox
      WHERE ${inboxScope} AND run_id=${runId} AND state='running'`.execute(tx)).rows[0]
    if (!event) throw new CoreError('not_found', '本机 IM 投递不存在')
    const projection = (await sql<{ version: number; sealed_state: Buffer }>`SELECT version,sealed_state
      FROM desktop_im_projections WHERE ${inboxScope}`.execute(tx)).rows[0]
    if (action === 'read') {
      const plain = !projection && Boolean((await sql`SELECT 1 FROM desktop_im_delivery WHERE ${inboxScope}
        UNION ALL SELECT 1 FROM desktop_im_notices WHERE ${inboxScope} LIMIT 1`.execute(tx)).rows[0])
      return { version: projection?.version ?? 0, state: projection?.sealed_state.toString('base64') ?? null, ...(plain ? { plain: true } : {}) }
    }
    if (action === 'begin') {
      if (!projection) throw new CoreError('conflict', '本机 IM 投递缺少检查点')
      const inserted = await sql`INSERT INTO desktop_im_projection_receipts
        (owner_id,platform,connection_id,event_key,operation_key,fingerprint,state)
        VALUES (${owner},${platform},${connectionId},${eventKey},${key},${fingerprint},'sending')
        ON CONFLICT DO NOTHING RETURNING state`.execute(tx)
      if (inserted.rows.length) return 'new'
      const receipt = (await sql<{ state: string; fingerprint: string }>`SELECT state,fingerprint
        FROM desktop_im_projection_receipts WHERE ${inboxScope} AND operation_key=${key}`.execute(tx)).rows[0]
      if (!receipt || receipt.fingerprint !== fingerprint) return 'unknown'
      return receipt.state === 'accepted' ? 'accepted' : receipt.state === 'sending' ? 'pending' : 'unknown'
    }
    if (needsKey) {
      const settled = await sql`UPDATE desktop_im_projection_receipts
        SET state=${action === 'accepted' ? 'accepted' : outcome}
        WHERE ${inboxScope} AND operation_key=${key} AND state='sending' RETURNING state`.execute(tx)
      if (!settled.rows.length) throw new CoreError('conflict', '本机 IM 投递回执已变更')
      if (action === 'settle') return null
    }
    if ((projection?.version ?? 0) !== version)
      throw new CoreError('conflict', '本机 IM 投递检查点已变更')
    const next = (projection?.version ?? 0) + 1
    await sql`INSERT INTO desktop_im_projections (owner_id,platform,connection_id,event_key,version,sealed_state)
      VALUES (${owner},${platform},${connectionId},${eventKey},${next},${sealed})
      ON CONFLICT DO UPDATE SET version=excluded.version,sealed_state=excluded.sealed_state`.execute(tx)
    return next
  })
}

/** 被动与主动流分别以 QQ 的去重窗口持久分配序号。 */
export function nextDesktopQqSequence(db: Kysely<Database>, ownerId: string, fields: Fields) {
  const { botId, messageId } = fields
  if (typeof botId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(botId)
    || (messageId !== undefined && (typeof messageId !== 'string' || !messageId || messageId.length > 2048 || /[\r\n\0]/.test(messageId))))
    throw new CoreError('invalid_request', 'QQ 序号作用域无效')
  const key = createHash('sha256').update(JSON.stringify([ownerId, botId, messageId ?? null])).digest('hex')
  const now = Date.now()
  return db.transaction().execute(async tx => {
    await sql`DELETE FROM desktop_qq_sequences WHERE expires_ms <= ${now}`.execute(tx)
    const result = await sql<{ value: number }>`INSERT INTO desktop_qq_sequences(sequence_key,value,expires_ms)
      VALUES (${key},1,${now + (messageId === undefined ? 600_000 : 4_200_000)})
      ON CONFLICT(sequence_key) DO UPDATE SET value=value+1 RETURNING value`.execute(tx)
    const value = result.rows[0]?.value
    if (!value || !Number.isSafeInteger(value)) throw new CoreError('storage_error', 'QQ 持久序号不可用')
    return value
  })
}

/** 文件投递绑定活动私聊、原始收件及该轮实际收到的附件。 */
export async function desktopImAttachmentDelivery(
  db: Kysely<Database>, identity: RunIdentity, source: string,
  action: 'read' | 'begin' | 'accepted' | 'rejected' | 'unknown',
) {
  const owner = identity.ownerId.toLowerCase().replaceAll('-', '')
  const session = Number(identity.sessionId)
  const attachId = /^[0-9a-f]{32}$/u.test(source) ? source : null
  const filePath = source.length <= 2048 && /^\/(personal|project|workspace)\/[^\x00-\x1f\x7f\\]+$/u.test(source) ? source : null
  if (!Number.isSafeInteger(session) || session <= 0 || (!attachId && !filePath)) return null
  const noticeKey = createHash('sha256').update(JSON.stringify(['im-attachment', identity.runId, source])).digest('hex')

  return db.transaction().execute(async tx => {
    const { rows } = await sql<{
      platform: string; connection_id: string; event_key: string; client_message_id: string; sealed_event: Buffer
      name: string; ext: string; mime: string | null; size: number; storage_key: string
    }>`
      SELECT i.platform,i.connection_id,i.event_key,m.client_message_id,i.sealed_event,f.name,f.ext,f.mime,f.size,f.storage_key
      FROM agent_run_admissions a
      JOIN conversation_sessions s ON s.id=a.session_id AND s.user_id=a.user_id
        AND s.active_run_id=a.run_id AND s.chat_type IN ('c2c','group')
      JOIN conversation_messages m ON m.id=a.user_message_id AND m.session_id=s.id
      LEFT JOIN chat_attachments f ON f.user_id=a.user_id AND f.message_id=m.id AND f.attach_id=${attachId}
      JOIN desktop_im_sessions im ON im.session_id=s.id AND im.owner_id=s.user_id
      JOIN desktop_im_inbox i ON i.owner_id=im.owner_id AND i.platform=im.platform AND i.connection_id=im.connection_id
      WHERE a.user_id=${owner} AND a.session_id=${session} AND a.run_id=${identity.runId}
        AND (${filePath} IS NULL OR s.chat_type='c2c')
        AND (${attachId} IS NULL OR f.state='attached' AND f.storage_key=${`agent-attachments/${attachId}`})
        AND (i.run_id=a.run_id AND i.state='running' OR i.run_id IS NULL AND i.state='pending')
      ORDER BY (i.run_id IS NULL),i.received_at,i.rowid LIMIT 1`.execute(tx)
    const event = rows[0]
    if (!event || imClientId(event.platform, event.connection_id, event.event_key) !== event.client_message_id) return null

    const scope = sql`owner_id=${owner} AND platform=${event.platform} AND connection_id=${event.connection_id}
      AND event_key=${event.event_key} AND notice_key=${noticeKey}`
    if (action === 'begin') {
      const inserted = await sql`INSERT INTO desktop_im_notices (owner_id,platform,connection_id,event_key,notice_key,state)
        VALUES (${owner},${event.platform},${event.connection_id},${event.event_key},${noticeKey},'sending')
        ON CONFLICT DO NOTHING RETURNING state`.execute(tx)
      if (inserted.rows.length) return {
        state: 'new' as const, platform: event.platform, connectionId: event.connection_id,
        eventKey: event.event_key, sealedEvent: event.sealed_event.toString('base64'), deliveryId: noticeKey,
        ...(filePath ? { filePath } : { attachId,
          attachment: { name: event.name, ext: event.ext, mime: event.mime, size: event.size, storageKey: event.storage_key } }),
      }
    } else if (action !== 'read') {
      await sql`UPDATE desktop_im_notices SET state=${action} WHERE ${scope} AND state='sending'`.execute(tx)
    }
    const receipt = (await sql<{ state: string }>`SELECT state FROM desktop_im_notices WHERE ${scope}`.execute(tx)).rows[0]
    if (!receipt) return null
    return { state: receipt.state === 'accepted' ? 'accepted' as const : receipt.state === 'rejected' ? 'rejected' as const : 'unknown' as const }
  })
}

/** 引用只读取同一连接已登记的原始附件，草稿尚未转入会话时也可引用。 */
export async function readDesktopImAttachmentReference(db: Kysely<Database>, ownerId: string, fields: Fields) {
  const owner = ownerId.toLowerCase().replaceAll('-', '')
  const { platform, connectionId } = connectionScope(fields)
  const { sourceMessageId, sourceIndex } = fields
  if (platform !== 'telegram' || typeof sourceMessageId !== 'string' || sourceMessageId.length > 256
    || !/^[0-9]+:-?[0-9]+:[0-9]+$/u.test(sourceMessageId) || typeof sourceIndex !== 'number'
    || !Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= 32) return null
  const { rows } = await sql<{
    attachId: string; storageKey: string; name: string; ext: string; mime: string | null; size: number; kind: string; transcript: string | null
  }>`
    SELECT a.attach_id AS attachId,a.storage_key AS storageKey,a.name,a.ext,a.mime,a.size,a.kind,json_extract(a.extra,'$.transcript') AS transcript
    FROM chat_attachments a JOIN desktop_im_inbox i ON i.owner_id=a.user_id AND i.platform=${platform}
      AND i.connection_id=${connectionId} AND i.event_key=json_extract(a.extra,'$.im.eventKey')
    WHERE a.user_id=${owner} AND a.state IN ('draft','attached') AND i.state IN ('pending','running','completed')
      AND json_extract(a.extra,'$.im.platform')=${platform} AND json_extract(a.extra,'$.im.connectionId')=${connectionId}
      AND json_extract(a.extra,'$.im.sourceMessageId')=${sourceMessageId} AND json_extract(a.extra,'$.im.sourceIndex')=${sourceIndex}
    LIMIT 2`.execute(db)
  return rows.length === 1 ? rows[0]! : null
}
