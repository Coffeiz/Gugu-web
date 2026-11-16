import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { tmpdir } from 'node:os'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { imageSizeFromFile } from 'image-size/fromFile'
import { removeLocalTree } from '@gugu/fs/node'
import { assertChatAttachmentCapacity, CHAT_ATTACHMENT_STAGING_BYTES, classifyChatAttachment, planChatAttachmentProcessing } from '@gugu/core/agent/attachments/staging'
import type { AgentAttachmentUploadOperations, AgentAttachmentUploadInput } from './attachment-upload.js'
import type { ChatAttachmentDraftDeletePorts } from '@gugu/core/agent/attachments/delete-draft'
import type { ChatAttachmentDraftClearPorts } from '@gugu/core/agent/attachments/clear-drafts'
import { normalizeFileOwnerId } from '../../domains/files/file-owner.js'

const execFile = promisify(execFileCallback)
const inside = (root: string, candidate: string) => candidate === root || candidate.startsWith(`${root}${path.sep}`)

interface UsedBytesRow extends QueryResultRow { used: string | number }
interface DraftAttachmentRow extends QueryResultRow { state: string; storage_key: string }

async function stagingPath(rootPath: string, key: string): Promise<string> {
  const segments = key.split('/')
  if (segments.length !== 3 || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')))
    throw new Error('附件存储位置无效')
  await mkdir(rootPath, { recursive: true, mode: 0o700 })
  const root = await realpath(rootPath)
  let current = root
  for (const [index, segment] of segments.entries()) {
    current = path.resolve(current, segment)
    if (!inside(root, current)) throw new Error('附件存储位置无效')
    const last = index === segments.length - 1
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || (!last && !info.isDirectory()) || (last && !info.isFile())) throw new Error('附件存储位置无效')
      if (last) throw Object.assign(new Error('附件暂存标识冲突'), { code: 'EEXIST' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!last) await mkdir(current, { mode: 0o700 })
    }
    if (!last) {
      const canonical = await realpath(current)
      if (!inside(root, canonical) || canonical !== current) throw new Error('附件存储位置无效')
    }
  }
  return current
}

async function probeImage(filePath: string, ext: string): Promise<{ width: number | null; height: number | null }> {
  if (ext === 'svg') return { width: null, height: null }
  try {
    const result = await imageSizeFromFile(filePath)
    return { width: result.width ?? null, height: result.height ?? null }
  } catch { return { width: null, height: null } }
}

async function probeDuration(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFile('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', filePath], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    const value = Number(stdout.trim())
    return Number.isFinite(value) && value > 0 ? Math.round(value * 10) / 10 : null
  } catch { return null }
}

async function transcodeAudio(filePath: string, ext: string): Promise<Buffer | null> {
  // SILK 需要 pilk 解码；Node Host 没有等价依赖时按 Python 的“解码工具缺失则原样暂存”降级。
  if (['silk', 'sil', 'slk'].includes(ext)) return null
  const directory = await mkdtemp(path.join(tmpdir(), 'gugu-audio-'))
  const output = path.join(directory, 'converted.mp3')
  try {
    await execFile('ffmpeg', ['-y', '-i', filePath, '-codec:a', 'libmp3lame', '-q:a', '4', output], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
    const info = await stat(output)
    return info.isFile() && info.size > 0 ? await import('node:fs/promises').then(fs => fs.readFile(output)) : null
  } catch { return null }
  finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined) }
}

async function copyStagedFile(source: string, destination: string): Promise<void> {
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  await chmod(destination, 0o600)
}

/** PostgreSQL 事务串行化同 owner 的容量检查，并在提交前写入私有附件字节。 */
export function createPostgresAgentAttachmentUploadOperations(pool: Pick<Pool, 'connect' | 'query'>, storageRoot: string): AgentAttachmentUploadOperations {
  async function usedBytes(owner: string, client?: PoolClient): Promise<number> {
    const query = client ?? pool
    const result = await query.query<UsedBytesRow>(`SELECT COALESCE(SUM(size),0)::bigint AS used FROM chat_attachments
      WHERE user_id=$1 AND state IN ('draft','attached')`, [owner])
    const used = Number(result.rows[0]?.used ?? 0)
    if (!Number.isSafeInteger(used) || used < 0) throw new Error('附件暂存容量记录无效')
    return used
  }

  return {
    async capacity(ownerId) {
      const owner = normalizeFileOwnerId(ownerId)
      return Math.max(CHAT_ATTACHMENT_STAGING_BYTES - await usedBytes(owner), 0)
    },
    async stage(ownerId, input: AgentAttachmentUploadInput) {
      const owner = normalizeFileOwnerId(ownerId)
      const processing = planChatAttachmentProcessing({ ext: input.ext, mime: input.mime, size: input.size, voice: input.voice })
      const attachId = randomUUID().replaceAll('-', '').slice(0, 16)
      let ext = input.ext.toLowerCase().slice(0, 10)
      let mime = ext === 'mp3' ? 'audio/mpeg' : input.mime
      let size = input.size
      let image = { width: null as number | null, height: null as number | null }
      let duration: number | null = null
      let content: Buffer | null = null

      if (processing.materialize) {
        content = await import('node:fs/promises').then(fs => fs.readFile(input.path))
        if (processing.transcode) {
          const converted = await transcodeAudio(input.path, ext)
          if (converted) { content = converted; ext = 'mp3'; mime = 'audio/mpeg' }
        }
        size = content!.length
      }
      const kind = input.voice ? 'voice' : classifyChatAttachment(ext)
      const subdir = input.voice ? '.voice' : '.chat_staging'
      const storageKey = `${owner}/${subdir}/${attachId}.${ext || 'bin'}`
      let target: string | null = null
      let ownsTarget = false
      let client: PoolClient | undefined
      try {
        client = await pool.connect()
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [owner])
        assertChatAttachmentCapacity(await usedBytes(owner, client), size, CHAT_ATTACHMENT_STAGING_BYTES)
        target = await stagingPath(storageRoot, storageKey)
        if (content === null) { await copyStagedFile(input.path, target); ownsTarget = true }
        else {
          const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
          ownsTarget = true
          try { await handle.writeFile(content); await handle.sync() }
          finally { await handle.close() }
        }
        if (kind === 'image') image = await probeImage(target, ext)
        if (input.voice) duration = await probeDuration(target)
        await client.query(`INSERT INTO chat_attachments
          (attach_id,user_id,message_id,storage_key,platform,platform_message_id,attachment_index,name,ext,mime,kind,size,duration,img_width,img_height,state,extra,created_at,attached_at)
          VALUES($1,$2,NULL,$3,'web',NULL,NULL,$4,$5,$6,$7,$8,$9,$10,$11,'draft',NULL,CURRENT_TIMESTAMP,NULL)`,
        [attachId, owner, storageKey, input.name, ext, mime, kind, size, duration, image.width, image.height])
        await client.query('COMMIT')
        return { attach_id: attachId, name: input.name, ext, size, kind, duration, img_width: image.width, img_height: image.height, qq_face: null }
      } catch (error) {
        await client?.query('ROLLBACK').catch(() => undefined)
        if (target && ownsTarget) await rm(target, { force: true }).catch(() => undefined)
        throw error
      } finally { client?.release() }
    },
  }
}

/** PostgreSQL owner/状态事务及与 Python 共享的 storage_key advisory lock；物理字节在行提交后清理。 */
export function createPostgresChatAttachmentDraftDeletePorts(
  pool: Pick<Pool, 'connect'>,
  storageRoot: string,
): ChatAttachmentDraftDeletePorts & Pick<ChatAttachmentDraftClearPorts, 'deleteDraftRows'> {
  return {
    async deleteDraftRows(ownerId) {
      const owner = normalizeFileOwnerId(ownerId)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const deleted = await client.query<{ storage_key: string } & QueryResultRow>(`DELETE FROM chat_attachments
          WHERE user_id=$1 AND state='draft' RETURNING storage_key`, [owner])
        await client.query('COMMIT')
        return deleted.rows.map(row => row.storage_key)
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally { client.release() }
    },
    async removeDraft(ownerId, attachmentId) {
      const owner = normalizeFileOwnerId(ownerId)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const selected = await client.query<DraftAttachmentRow>(`SELECT state,storage_key FROM chat_attachments
          WHERE user_id=$1 AND attach_id=$2 FOR UPDATE`, [owner, attachmentId])
        const row = selected.rows[0]
        if (!row) {
          await client.query('ROLLBACK')
          return null
        }
        if (row.state !== 'draft') {
          await client.query('ROLLBACK')
          return 'already-used'
        }
        const deleted = await client.query(`DELETE FROM chat_attachments
          WHERE user_id=$1 AND attach_id=$2 AND state='draft'`, [owner, attachmentId])
        if (deleted.rowCount !== 1) {
          await client.query('ROLLBACK')
          return 'already-used'
        }
        await client.query('COMMIT')
        return { storageKey: row.storage_key }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally { client.release() }
    },
    async removeUnreferenced(ownerId, storageKey) {
      const owner = normalizeFileOwnerId(ownerId)
      if (!storageKey.startsWith(`${owner}/`)) return false
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`chat-attachment:${owner}:${storageKey}`])
        const referenced = await client.query(`SELECT 1 FROM chat_attachments
          WHERE user_id=$1 AND storage_key=$2 LIMIT 1`, [owner, storageKey])
        const unreferenced = !referenced.rowCount
        if (unreferenced) {
          try { await removeLocalTree(storageRoot, storageKey) } catch { /* 与 Python 一致：数据库删除成功后物理清理失败可重试修复。 */ }
        }
        await client.query('COMMIT')
        return unreferenced
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally { client.release() }
    },
  }
}
