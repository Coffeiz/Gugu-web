import type { Pool } from 'pg'
import { CoreError, normalizeThemePalette } from '@gugu/core'
import { createEmailAttachmentResolver, EmailAttachmentError, renderSmtpDraftMessage, SmtpDeliveryFailure,
  type EmailAttachmentReferences, type SmtpTestDelivery } from '@gugu/core/email/smtp-test'
import { openLocalFile } from '@gugu/fs/node'
import { lookup as lookupMimeType } from 'mime-types'
import type { FileHandle } from 'node:fs/promises'
import type { ScheduledTaskTestNotificationPlan } from '@gugu/core/scheduled-task-test-notify'
import { decryptEncryptedString } from '../../adapters/security/encrypted-string.js'
import { isOwnedFileStorageKey } from '../files/file-owner.js'

type OpenFile = { handle: FileHandle; size: number }
type GeneratedFile = OpenFile & { fileName: string; mimeType: string }
type FileRow = {
  id: number
  storage_key: string
  storage_backend: string
  size_bytes: string | number | null
  display_name: string
  ext: string
  mime_type: string | null
}

function attachmentSource(file: OpenFile) {
  return {
    size: file.size,
    async read(limit: number) {
      const chunks: Buffer[] = []
      let offset = 0
      while (offset < limit) {
        const chunk = Buffer.allocUnsafe(Math.min(limit - offset, 64 * 1024))
        const { bytesRead } = await file.handle.read(chunk, 0, chunk.length, offset)
        if (!bytesRead) break
        chunks.push(chunk.subarray(0, bytesRead))
        offset += bytesRead
      }
      return Buffer.concat(chunks, offset)
    },
    close: () => file.handle.close(),
  }
}

interface EmailRow {
  preferences: unknown
  smtp_host: string | null
  smtp_port: number | null
  smtp_user: string | null
  smtp_password: string | null
  smtp_from_addr: string | null
  smtp_use_ssl: boolean | null
}

export interface SmtpFallback {
  host: string
  port: number
  user: string
  password: string
  fromAddress: string
  enabled: boolean
  useSsl: boolean
}

interface EmailProfile extends EmailRow {
  readonly ownerEmail: string | null
}

export async function readEmailProfile(pool: Pick<Pool, 'query'>, ownerId: string): Promise<EmailProfile | undefined> {
  const result = await pool.query<EmailRow>(
    `SELECT u.email AS owner_email,p.data AS preferences,s.host AS smtp_host,s.port AS smtp_port,
            s."user" AS smtp_user,s.password AS smtp_password,s.from_addr AS smtp_from_addr,
            s.use_ssl AS smtp_use_ssl
       FROM users u
       LEFT JOIN user_preferences p ON p.user_id=u.id
       LEFT JOIN user_smtp_configs s ON s.user_id=u.id AND s.enabled IS TRUE
      WHERE u.id=$1`,
    [ownerId],
  )
  const row = result.rows[0] as (EmailRow & { owner_email?: string | null }) | undefined
  return row ? { ...row, ownerEmail: row.owner_email ?? null } : undefined
}

export function preferences(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return {} }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function sender(from: string, user: string): { fromName: string; fromAddress: string } {
  if (from.includes('@')) return { fromName: '咕咕', fromAddress: from }
  return { fromName: from || '咕咕', fromAddress: user }
}

export function smtpSettings(row: EmailProfile, fallback: SmtpFallback, secretKey: string) {
  if (row.smtp_host !== null) {
    return {
      host: row.smtp_host,
      port: Number(row.smtp_port),
      user: row.smtp_user ?? '',
      password: decryptEncryptedString(secretKey, row.smtp_password ?? ''),
      from: row.smtp_from_addr ?? '',
      secure: Boolean(row.smtp_use_ssl),
    }
  }
  return {
    host: fallback.host,
    port: fallback.port,
    user: fallback.user,
    password: fallback.password,
    from: fallback.fromAddress,
    secure: fallback.useSsl,
  }
}

function reminderMessage(plan: ScheduledTaskTestNotificationPlan, value: unknown) {
  const prefs = preferences(value)
  const message = renderSmtpDraftMessage({
    subject: `咕咕 · ${plan.title}`,
    title: plan.title,
    preheader: '咕咕定时任务提醒',
    body: plan.text,
    sections: [{ heading: '任务内容', text: plan.text }],
    template: 'reminder',
    theme: prefs.theme === 'dark' ? 'dark' : 'light',
    palette: normalizeThemePalette(prefs.palette),
  })
  message.plain = plan.text
  return message
}

export function createPostgresEmailAttachmentResolver(
  pool: Pick<Pool, 'query'>,
  options: { storageRoot?: string; downloadGenerated?(ownerId: string, id: string): Promise<GeneratedFile> },
): ReturnType<typeof createEmailAttachmentResolver> {
  return createEmailAttachmentResolver({
    async files(ownerId, ids) {
      const { rows } = await pool.query<FileRow>(
        `SELECT id,storage_key,storage_backend,size_bytes,display_name,ext,mime_type
         FROM files WHERE user_id=$1 AND id=ANY($2::int[]) AND deleted_at IS NULL`, [ownerId, ids])
      return rows.map(row => ({ id: row.id, storageKey: row.storage_backend === 'local' ? row.storage_key : '',
        size: Number(row.size_bytes ?? 0), name: row.display_name, ext: row.ext, mimeType: row.mime_type }))
    },
    async openFile(ownerId, file) {
      if (!options.storageRoot || !isOwnedFileStorageKey(ownerId, file.storageKey)) return null
      const opened = await openLocalFile(options.storageRoot, file.storageKey)
      return opened ? attachmentSource(opened) : null
    },
    async openGenerated(ownerId, id) {
      try {
        const file = await options.downloadGenerated?.(ownerId, id)
        return file ? { ...attachmentSource(file), filename: file.fileName, mimeType: file.mimeType } : null
      } catch (error) {
        if (error instanceof CoreError && error.code === 'not_found') return null
        throw error
      }
    },
    guessMimeType: lookupMimeType,
  })
}

/** 使用 owner 的注册邮箱和启用的 SMTP 配置投递提醒测试邮件。 */
export function createPostgresScheduledTaskTestEmailDelivery(
  pool: Pick<Pool, 'query'>,
  options: {
    secretKey: string
    globalSmtp: SmtpFallback
    send(delivery: SmtpTestDelivery): Promise<void>
    storageRoot?: string
    downloadGenerated?(ownerId: string, id: string): Promise<GeneratedFile>
  },
) {
  const resolveAttachments = createPostgresEmailAttachmentResolver(pool, options)
  return async (plan: ScheduledTaskTestNotificationPlan, references?: EmailAttachmentReferences, recipient?: string | null): Promise<Record<string, string>> => {
    try {
      const row = await readEmailProfile(pool, plan.ownerId)
      const toAddress = recipient === undefined ? row?.ownerEmail : recipient
      if (!row || !toAddress) return { '邮件': '收件人邮箱不存在' }
      const attachments = references ? await resolveAttachments(plan.ownerId, references) : []
      const smtp = smtpSettings(row, options.globalSmtp, options.secretKey)
      if (!smtp.host) return { '邮件': '发送失败（smtp_not_configured）' }
      await options.send({
        host: smtp.host,
        port: smtp.port,
        user: smtp.user,
        password: smtp.password,
        ...sender(smtp.from, smtp.user),
        toAddress,
        secure: smtp.secure,
        message: reminderMessage(plan, row.preferences),
        ...(attachments.length ? { attachments } : {}),
      })
      return { '邮件': '已发送' }
    } catch (error) {
      if (error instanceof EmailAttachmentError) return { '邮件': `附件不可用（${error.message}）` }
      const reason = error instanceof SmtpDeliveryFailure ? error.reason : 'delivery'
      const code = reason === 'tls_mismatch' ? 'smtp_tls_mismatch' : reason === 'tls' ? 'smtp_tls_error' : 'smtp_delivery_error'
      return { '邮件': `发送失败（${code}）` }
    }
  }
}
