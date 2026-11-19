import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { openLocalFile } from '@gugu/fs/node'
import type { ImAccessScope } from '@gugu/core/im/access'
import type { ImConversationAttachments } from './conversation-postgres.js'
import { normalizeFileOwnerId } from '../../files/file-owner.js'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'
import { createPostgresAgentAttachmentUploadOperations, createPostgresChatAttachmentDraftDeletePorts } from '../../agent/attachment-staging-postgres.js'

export interface ImAttachmentScope extends ImAccessScope { readonly chatId: string | null }
export interface ImAttachmentStageInput {
  readonly scope: ImAttachmentScope
  readonly sourcePlatformMessageId: string
  readonly sourceAttachmentIndex: number
  readonly name: string
  readonly ext: string
  readonly mime: string
  readonly bytes: Uint8Array
  readonly voice?: boolean
  readonly qqFace?: boolean
  readonly quoted?: boolean
}
export interface ImStagedAttachment { ownerId: string; attachId: string; created: boolean; creationReceipt?: string }
export interface ImAttachmentReleaseInput { scope: ImAttachmentScope; attachId: string; creationReceipt: string }
export class ImAttachmentIngressError extends Error {
  constructor() { super('IM 附件暂存未完成'); this.name = 'ImAttachmentIngressError' }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function validScope(input: ImAttachmentScope): ImAttachmentScope {
  try {
    if (!['feishu', 'qq', 'wechat', 'telegram'].includes(input.platform) || !/^[1-9]\d{0,9}$/.test(input.botId)
      || Number(input.botId) > 2_147_483_647 || !['group', 'c2c'].includes(input.chatType)
      || !input.platformUserId || input.platformUserId.length > 256 || /[\x00-\x1f\x7f]/.test(input.platformUserId)
      || input.chatType === 'group' && (!input.chatId || input.chatId.length > 256 || /[\x00-\x1f\x7f]/.test(input.chatId))) throw new ImAttachmentIngressError()
    return Object.freeze({ ...input, ownerId: normalizeFileOwnerId(input.ownerId), chatId: input.chatType === 'group' ? input.chatId : null })
  } catch { throw new ImAttachmentIngressError() }
}
export function imAttachmentScopeKey(raw: ImAttachmentScope): string {
  const scope = validScope(raw)
  return hash([scope.ownerId, scope.platform, scope.botId, scope.chatType, scope.chatType === 'group' ? scope.chatId : scope.platformUserId])
}
function sourceKey(scope: ImAttachmentScope, messageId: string, index: number, quoted = false): string {
  if (typeof messageId !== 'string' || !messageId || messageId.length > 8192 || /[\x00-\x1f\x7f]/.test(messageId)
    || !Number.isSafeInteger(index) || index < 0 || index > 100) throw new ImAttachmentIngressError()
  return hash([imAttachmentScopeKey(scope), messageId, index, quoted])
}
const cardFields = 'attach_id,name,ext,mime,size,kind,duration,img_width,img_height,storage_key,extra,state,message_id'
function card(row: Record<string, unknown>) {
  const extra = row.extra as Record<string, unknown> | null
  return { attach_id: row.attach_id, name: row.name, ext: row.ext, mime: row.mime, size_bytes: Number(row.size), kind: row.kind,
    duration: row.duration, img_width: row.img_width, img_height: row.img_height, qq_face: extra?.qq_face === true, quoted: extra?.quoted === true, upload: true }
}

/** 复用正式上传字节/容量/转码实现；来源标注和失败补偿仅限本次创建的draft。 */
export function createPostgresImAttachmentIngress(options: {
  pool: Pick<Pool, 'connect' | 'query'>
  storageRoot: string
  tempDirectory?: string
  supportedPlatforms(): readonly string[] | Promise<readonly string[]>
}) {
  // 当前FS2.0安全删除以Linux目录句柄锚定，其他平台不能先写入再假称已补偿。
  if (process.platform !== 'linux') throw new ImAttachmentIngressError()
  const uploads = createPostgresAgentAttachmentUploadOperations(options.pool, options.storageRoot)
  const deletion = createPostgresChatAttachmentDraftDeletePorts(options.pool, options.storageRoot)
  async function removeUnreferenced(owner: string, storageKey: string) {
    if (!await deletion.removeUnreferenced(owner, storageKey)) return
    // 既有Web草稿清理为best-effort；IM的本次创建补偿必须验证实际字节已移除。
    const remaining = await openLocalFile(options.storageRoot, storageKey)
    if (remaining) { await remaining.handle.close(); throw new ImAttachmentIngressError() }
  }
  async function authorize(client: PoolClient, scope: ImAttachmentScope) {
    if (!(await options.supportedPlatforms()).includes(scope.platform)) throw new ImAttachmentIngressError()
    const result = await client.query(`SELECT b.id FROM user_bots b JOIN users u ON u.id=b.user_id
      WHERE b.id=$1::integer AND b.user_id=$2::uuid AND b.platform=$3 AND b.enabled IS TRUE
        AND u.is_active IS TRUE AND COALESCE(u.account_status,'active')='active'
        AND ($4::text='c2c' OR CASE WHEN b.platform='feishu' THEN b.feishu_group_chat_enabled IS DISTINCT FROM FALSE
          WHEN b.platform IN ('qq','telegram') THEN b.group_chat_enabled IS TRUE ELSE FALSE END)
      FOR SHARE OF b,u`, [scope.botId, scope.ownerId, scope.platform, scope.chatType])
    if (result.rows.length !== 1) throw new ImAttachmentIngressError()
  }
  async function compensate(ownerId: string, attachId: string) {
    const removed = await deletion.removeDraft(ownerId, attachId)
    if (removed && removed !== 'already-used') await removeUnreferenced(ownerId, removed.storageKey)
  }
  async function stage(input: ImAttachmentStageInput, signal?: AbortSignal): Promise<ImStagedAttachment> {
    const scope = validScope(input.scope), source = sourceKey(scope, input.sourcePlatformMessageId, input.sourceAttachmentIndex, input.quoted)
    if (!(input.bytes instanceof Uint8Array) || !input.bytes.byteLength || input.bytes.byteLength > 64 * 1024 * 1024
      || !input.name || input.name.length > 250 || /[\x00-\x1f\x7f\\/]/.test(input.name)
      || !/^[a-zA-Z0-9]{0,10}$/.test(input.ext) || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(input.mime)) throw new ImAttachmentIngressError()
    const bytes = Buffer.from(input.bytes), metadata = { name: input.name, ext: input.ext, mime: input.mime, voice: input.voice === true,
      qq_face: input.qqFace === true, quoted: input.quoted === true }
    const fingerprint = hash([metadata, createHash('sha256').update(bytes).digest('hex')])
    const platformMessage = hash(input.sourcePlatformMessageId), index = input.sourceAttachmentIndex
    async function lookup(client: PoolClient): Promise<ImStagedAttachment | null> {
      await authorize(client, scope)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`im-attachment:${scope.ownerId}:${source}`])
      const old = await client.query(`SELECT attach_id,extra FROM chat_attachments WHERE user_id=$1 AND extra->>'im_ingress_source'=$2
        AND (state='attached' OR state='draft' AND created_at>clock_timestamp()-interval '24 hours')`, [scope.ownerId, source])
      if (old.rows.length > 1) throw new ImAttachmentIngressError()
      if (!old.rows[0]) return null
      if (old.rows[0].extra?.im_ingress_fingerprint !== fingerprint) throw new ImAttachmentIngressError()
      return { ownerId: scope.ownerId, attachId: String(old.rows[0].attach_id), created: false }
    }
    let temporary: string | undefined, created: string | undefined
    try {
      signal?.throwIfAborted()
      const existing = await withPostgresTransaction(options.pool, lookup)
      if (existing) return existing
      temporary = await mkdtemp(path.join(options.tempDirectory ?? tmpdir(), 'gugu-im-upload-'))
      const file = path.join(temporary, 'content')
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); signal?.throwIfAborted()
      // 正式upload自身管理事务；不能在持有另一连接/事务时等待它，避免池耗尽自锁。
      const stored = await uploads.stage(scope.ownerId, { path: file, name: metadata.name, ext: metadata.ext, mime: metadata.mime, size: bytes.length, voice: metadata.voice })
      created = stored.attach_id
      const result = await withPostgresTransaction(options.pool, async client => {
        const concurrent = await lookup(client)
        if (concurrent) return concurrent
        const receipt = randomUUID()
        const extra = { im_ingress_scope: imAttachmentScopeKey(scope), im_ingress_source: source, im_ingress_receipt: receipt,
          im_ingress_fingerprint: fingerprint, qq_face: metadata.qq_face, quoted: metadata.quoted }
        const changed = await client.query(`UPDATE chat_attachments SET platform=$3,platform_message_id=$4,attachment_index=$5,extra=$6::jsonb
          WHERE user_id=$1 AND attach_id=$2 AND state='draft' RETURNING attach_id`,
        [scope.ownerId, stored.attach_id, scope.platform, platformMessage, index, JSON.stringify(extra)])
        if (changed.rows.length !== 1) throw new ImAttachmentIngressError()
        signal?.throwIfAborted()
        return { ownerId: scope.ownerId, attachId: stored.attach_id, created: true, creationReceipt: receipt }
      })
      if (!result.created) { await compensate(scope.ownerId, created); created = undefined }
      return result
    } catch {
      if (created) { try { await compensate(scope.ownerId, created) } catch { throw new ImAttachmentIngressError() } }
      throw new ImAttachmentIngressError()
    } finally {
      if (temporary) try { await rm(temporary, { recursive: true, force: true }) } catch { throw new ImAttachmentIngressError() }
    }
  }
  async function reuse(input: { scope: ImAttachmentScope; sourcePlatformMessageId: string; sourceAttachmentIndex: number; targetPlatformMessageId: string }, signal?: AbortSignal): Promise<ImStagedAttachment | null> {
    const scope = validScope(input.scope), source = sourceKey(scope, input.sourcePlatformMessageId, input.sourceAttachmentIndex)
    const target = sourceKey(scope, input.targetPlatformMessageId, input.sourceAttachmentIndex, true)
    try {
      signal?.throwIfAborted()
      return await withPostgresTransaction(options.pool, async client => {
        await authorize(client, scope)
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`im-attachment:${scope.ownerId}:${target}`])
        const previous = await client.query(`SELECT attach_id FROM chat_attachments WHERE user_id=$1 AND extra->>'im_ingress_source'=$2
          AND (state='attached' OR state='draft' AND created_at>clock_timestamp()-interval '24 hours')`, [scope.ownerId, target])
        if (previous.rows.length > 1) throw new ImAttachmentIngressError()
        if (previous.rows[0]) return { ownerId: scope.ownerId, attachId: String(previous.rows[0].attach_id), created: false }
        const rows = await client.query(`SELECT ${cardFields} FROM chat_attachments WHERE user_id=$1 AND state='attached'
          AND extra->>'im_ingress_source'=$2 AND extra->>'im_ingress_scope'=$3 FOR SHARE`, [scope.ownerId, source, imAttachmentScopeKey(scope)])
        if (!rows.rows.length) return null
        if (rows.rows.length !== 1) throw new ImAttachmentIngressError()
        const original = rows.rows[0]!, id = randomUUID().replaceAll('-', '').slice(0, 16), receipt = randomUUID()
        const extra = { ...original.extra, im_ingress_source: target, im_ingress_receipt: receipt, quoted: true }
        const inserted = await client.query(`INSERT INTO chat_attachments
          (attach_id,user_id,storage_key,platform,platform_message_id,attachment_index,name,ext,mime,kind,size,duration,img_width,img_height,state,extra,created_at)
          SELECT $3,user_id,storage_key,platform,$4,attachment_index,name,ext,mime,kind,size,duration,img_width,img_height,'draft',$5::jsonb,clock_timestamp()
          FROM chat_attachments WHERE user_id=$1 AND attach_id=$2 AND state='attached' RETURNING attach_id`,
        [scope.ownerId, original.attach_id, id, hash(input.targetPlatformMessageId), JSON.stringify(extra)])
        if (inserted.rows.length !== 1) throw new ImAttachmentIngressError()
        signal?.throwIfAborted()
        return { ownerId: scope.ownerId, attachId: id, created: true, creationReceipt: receipt }
      })
    } catch { throw new ImAttachmentIngressError() }
  }
  async function release(input: ImAttachmentReleaseInput): Promise<void> {
    try {
      const scope = validScope(input.scope), owner = scope.ownerId
      const removed = await options.pool.query<{ storage_key: string }>(`DELETE FROM chat_attachments WHERE user_id=$1 AND attach_id=$2
        AND state='draft' AND extra->>'im_ingress_receipt'=$3 AND extra->>'im_ingress_scope'=$4 RETURNING storage_key`,
      [owner, input.attachId, input.creationReceipt, imAttachmentScopeKey(scope)])
      for (const row of removed.rows) await removeUnreferenced(owner, row.storage_key)
    } catch { throw new ImAttachmentIngressError() }
  }
  function conversation(raw: ImAttachmentScope): ImConversationAttachments {
    const scope = validScope(raw)
    return { mode: 'enabled', async resolve(client, owner, ids) {
      if (owner !== scope.ownerId) throw new ImAttachmentIngressError()
      await authorize(client, scope)
      const rows = await client.query(`SELECT ${cardFields} FROM chat_attachments WHERE user_id=$1 AND attach_id=ANY($2::text[])
        AND state='draft' AND created_at>clock_timestamp()-interval '24 hours' AND extra->>'im_ingress_scope'=$3`, [owner, [...ids], imAttachmentScopeKey(scope)])
      const byId = new Map(rows.rows.map(row => [row.attach_id, row]))
      if (rows.rows.length !== ids.length || ids.some(id => !byId.has(id))) throw new ImAttachmentIngressError()
      return ids.map(id => card(byId.get(id)!))
    }, async claim(client, owner, messageId, ids) {
      if (owner !== scope.ownerId) throw new ImAttachmentIngressError()
      await authorize(client, scope)
      for (const id of ids) {
        const changed = await client.query(`UPDATE chat_attachments SET state='attached',message_id=$3,attached_at=clock_timestamp()
          WHERE user_id=$1 AND attach_id=$2 AND state='draft' AND created_at>clock_timestamp()-interval '24 hours'
            AND extra->>'im_ingress_scope'=$4 RETURNING attach_id`, [owner, id, messageId, imAttachmentScopeKey(scope)])
        if (changed.rows.length !== 1) throw new ImAttachmentIngressError()
      }
    } }
  }
  return { stage, reuse, release, conversation }
}
