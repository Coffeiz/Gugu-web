import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../../contracts/index.js'
import { databaseTime, nowUtc } from '../../data/codec.js'
import type { Database } from '../../data/schema.js'
import { assertChatAttachmentCapacity, CHAT_ATTACHMENT_STAGING_BYTES, classifyChatAttachment, planChatAttachmentProcessing } from './staging.js'
import type { DesktopAgentAttachment } from '../../contracts/desktop.js'

export interface DesktopChatAttachmentInput {
  attachId: string; name: string; ext: string; mime: string | null; size: number; voice: boolean; transcript?: string; duration?: number; quoted?: boolean
}
export interface DesktopChatAttachmentStorage {
  storageKey: string
  name: string
  ext: string
  mime: string | null
  size: number
}

function ownerKey(ownerId: string): string { return dataContext(ownerId).ownerId.replaceAll('-', '') }
function assertInput(input: DesktopChatAttachmentInput): void {
  if (!/^[0-9a-f]{32}$/.test(input.attachId) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 255
    || typeof input.ext !== 'string' || input.ext.length > 16 || (input.mime !== null && (typeof input.mime !== 'string' || input.mime.length > 255))
    || !Number.isSafeInteger(input.size) || input.size < 0 || typeof input.voice !== 'boolean')
    throw new CoreError('invalid_request', '附件信息无效')
  if (input.transcript !== undefined && (!input.voice || typeof input.transcript !== 'string'
    || !input.transcript.trim() || input.transcript.length > 8_000))
    throw new CoreError('invalid_request', '语音转写无效')
  if (input.duration !== undefined && (!input.voice || !Number.isFinite(input.duration) || input.duration <= 0 || input.duration > 65))
    throw new CoreError('invalid_request', '录音时长无效')
  planChatAttachmentProcessing({ ext: input.ext, mime: input.mime, size: input.size, voice: input.voice })
}

export async function stageDesktopChatAttachment(tx: Kysely<Database>, ownerId: string,
  input: DesktopChatAttachmentInput, reservation?: { platform: string; connectionId: string; clientId: string; eventKey?: string; sourceMessageId?: string; sourceIndex?: number }): Promise<DesktopAgentAttachment> {
  assertInput(input)
  const owner = ownerKey(ownerId)
  const kind = input.voice ? 'voice' : classifyChatAttachment(input.ext)
  const transcript = input.transcript?.trim()
  const quoted = input.quoted === true ? true : undefined
  const extra = transcript || reservation || quoted ? JSON.stringify({ transcript, im: reservation, quoted }) : null
  const storageKey = `agent-attachments/${input.attachId}`
  const { rows: usedRows } = await sql<{ used: number }>`SELECT coalesce(sum(size),0) AS used FROM chat_attachments
    WHERE user_id=${owner} AND state IN ('draft','attached')`.execute(tx)
  assertChatAttachmentCapacity(Number(usedRows[0]?.used ?? 0), input.size, CHAT_ATTACHMENT_STAGING_BYTES)
  const at = databaseTime(nowUtc(), 'sqlite')
  await sql`INSERT INTO chat_attachments
    (attach_id,user_id,message_id,storage_key,name,ext,mime,kind,size,duration,img_width,img_height,state,extra,created_at,attached_at)
    VALUES(${input.attachId},${owner},NULL,${storageKey},${input.name},${input.ext.toLowerCase()},${input.mime},${kind},${input.size},${input.duration ?? null},NULL,NULL,'draft',${extra},${at},NULL)`.execute(tx)
  return { attach_id: input.attachId, name: input.name, ext: input.ext.toLowerCase(), size: input.size,
    kind, mime: input.mime, duration: input.duration ?? null, img_width: null, img_height: null, upload: true, ...(transcript ? { transcript } : {}) }
}

export function createDesktopChatAttachmentStore(db: Kysely<Database>) {
  return {
    stage(ownerId: string, input: DesktopChatAttachmentInput): Promise<DesktopAgentAttachment> {
      return db.transaction().execute(tx => stageDesktopChatAttachment(tx, ownerId, input))
    },
    async deleteDraft(ownerId: string, attachId: string): Promise<string | null> {
      if (!/^[0-9a-f]{32}$/.test(attachId)) throw new CoreError('invalid_request', '附件标识无效')
      const owner = ownerKey(ownerId)
      const { rows } = await sql<{ storage_key: string }>`DELETE FROM chat_attachments
        WHERE user_id=${owner} AND attach_id=${attachId} AND state='draft' AND json_extract(extra,'$.im') IS NULL RETURNING storage_key`.execute(db)
      return rows[0]?.storage_key ?? null
    },
    async deleteDraftRows(ownerId: string): Promise<string[]> {
      const { rows } = await sql<{ storage_key: string }>`DELETE FROM chat_attachments
        WHERE user_id=${ownerKey(ownerId)} AND state='draft' AND json_extract(extra,'$.im') IS NULL RETURNING storage_key`.execute(db)
      return rows.map(row => row.storage_key)
    },
    async download(ownerId: string, attachId: string): Promise<DesktopChatAttachmentStorage> {
      if (!/^[0-9a-f]{32}$/.test(attachId)) throw new CoreError('invalid_request', '附件标识无效')
      const owner = ownerKey(ownerId)
      const { rows } = await sql<DesktopChatAttachmentStorage>`SELECT a.storage_key AS storageKey,a.name,a.ext,a.mime,a.size
        FROM chat_attachments a JOIN conversation_messages m ON m.id=a.message_id
        JOIN conversation_sessions s ON s.id=m.session_id
        WHERE a.user_id=${owner} AND s.user_id=${owner} AND a.attach_id=${attachId} AND a.state='attached'`.execute(db)
      const attachment = rows[0]
      if (!attachment || attachment.storageKey !== `agent-attachments/${attachId}`
        || !Number.isSafeInteger(Number(attachment.size)) || Number(attachment.size) < 0)
        throw new CoreError('not_found', '附件不存在或已过期')
      return { ...attachment, size: Number(attachment.size) }
    },
    async forSession(ownerId: string, sessionId: number): Promise<string[]> {
      const owner = ownerKey(ownerId)
      const { rows } = await sql<{ attach_id: string }>`SELECT a.attach_id FROM chat_attachments a
        JOIN conversation_messages m ON m.id=a.message_id
        JOIN conversation_sessions s ON s.id=m.session_id
        WHERE a.user_id=${owner} AND s.user_id=${owner} AND s.id=${sessionId} AND a.state='attached'`.execute(db)
      return rows.map(row => row.attach_id)
    },
  }
}

export async function claimDesktopChatAttachments(
  tx: Kysely<Database>, ownerId: string, messageId: number, attachIds: readonly string[],
  sessionId?: number, clientId?: string,
): Promise<Record<string, unknown>[]> {
  const owner = ownerKey(ownerId)
  const unique = [...new Set(attachIds)]
  if (unique.length > 32 || unique.some(id => !/^[0-9a-f]{32}$/.test(id))) throw new CoreError('invalid_request', '附件列表无效')
  if (!unique.length) return []
  const { rows } = await sql<{ attach_id: string; name: string; ext: string; mime: string | null; kind: string; size: number; duration: number | null; img_width: number | null; img_height: number | null; transcript: string | null; quoted: number | null }>`
    SELECT attach_id,name,ext,mime,kind,size,duration,img_width,img_height,
      CASE WHEN kind='voice' AND json_valid(extra) THEN json_extract(extra,'$.transcript') END AS transcript,
      json_extract(extra,'$.quoted') AS quoted
    FROM chat_attachments
    WHERE user_id=${owner} AND state='draft' AND attach_id IN (${sql.join(unique)})
      AND (json_extract(extra,'$.im') IS NULL OR (
        json_extract(extra,'$.im.clientId')=${clientId ?? null} AND EXISTS (
          SELECT 1 FROM desktop_im_sessions s WHERE s.owner_id=${owner} AND s.session_id=${sessionId ?? null}
            AND s.platform=json_extract(chat_attachments.extra,'$.im.platform')
            AND s.connection_id=json_extract(chat_attachments.extra,'$.im.connectionId')
        )
      )) ORDER BY rowid`.execute(tx)
  if (rows.length !== unique.length) throw new CoreError('not_found', '附件已失效，请重新添加')
  for (const id of unique) {
    const { rows: claimed } = await sql`UPDATE chat_attachments SET state='attached',message_id=${messageId},attached_at=${databaseTime(nowUtc(), 'sqlite')}
      WHERE user_id=${owner} AND attach_id=${id} AND state='draft' RETURNING attach_id`.execute(tx)
    if (!claimed.length) throw new CoreError('conflict', '附件已被其他消息使用')
  }
  return unique.map(id => {
    const row = rows.find(item => item.attach_id === id)!
    return { attach_id: row.attach_id, name: row.name, ext: row.ext, mime: row.mime, size_bytes: row.size,
      kind: row.kind, duration: row.duration, img_width: row.img_width, img_height: row.img_height, upload: true,
      ...(row.quoted === 1 ? { quoted: true } : {}),
      ...(typeof row.transcript === 'string' && row.transcript.trim() ? { transcript: row.transcript } : {}) }
  })
}
