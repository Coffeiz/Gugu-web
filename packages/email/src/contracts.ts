import { z } from 'zod'

export const mailPresets = {
  gmail: { imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  outlook: { imapHost: 'outlook.office365.com', smtpHost: 'smtp-mail.outlook.com', smtpPort: 587 },
  qq: { imapHost: 'imap.qq.com', smtpHost: 'smtp.qq.com', smtpPort: 465 },
  tencentExmail: { imapHost: 'imap.exmail.qq.com', smtpHost: 'smtp.exmail.qq.com', smtpPort: 465 },
  '163': { imapHost: 'imap.163.com', smtpHost: 'smtp.163.com', smtpPort: 465 },
  '126': { imapHost: 'imap.126.com', smtpHost: 'smtp.126.com', smtpPort: 465 },
  yeah: { imapHost: 'imap.yeah.net', smtpHost: 'smtp.yeah.net', smtpPort: 465 },
  icloud: { imapHost: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
} as const

const host = z.string().trim().toLowerCase().max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
export const mailAccountInput = z.object({
  email: z.email().max(254), username: z.string().trim().min(1).max(254).regex(/^[^\r\n\0]*$/),
  password: z.string().min(1).max(512).regex(/^[^\r\n\0]*$/),
  displayName: z.string().trim().max(80).regex(/^[^\r\n\0]*$/).optional(),
  senderName: z.string().trim().max(80).regex(/^[^\r\n\0]*$/).optional(),
  receiveOnly: z.boolean().optional(),
  smtpUsername: z.string().trim().min(1).max(254).regex(/^[^\r\n\0]*$/).optional(),
  smtpPassword: z.string().min(1).max(512).regex(/^[^\r\n\0]*$/).optional(),
  imapHost: host, smtpHost: z.union([host, z.literal('')]), smtpPort: z.union([z.literal(465), z.literal(587)]),
}).strict()
export const mailOAuthProvider = z.enum(['outlook', 'gmail'])
export type MailOAuthProvider = z.infer<typeof mailOAuthProvider>
export const mailOAuthCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('oauthProviders') }).strict(),
  z.object({ action: z.literal('oauthConnect'), provider: mailOAuthProvider,
    email: z.email().max(254), accountId: z.uuid().optional() }).strict(),
])
export type MailOAuthCommand = z.infer<typeof mailOAuthCommand>
const oauthCredential = z.object({
  provider: mailOAuthProvider, credentialId: z.uuid(), clientId: z.string().min(1).max(512),
  refreshToken: z.string().min(1).max(16384),
}).strict()

export const mailStoredAccount = mailAccountInput.extend({ id: z.uuid() }).extend({
  password: z.string().max(512).regex(/^[^\r\n\0]*$/),
  oauth: oauthCredential.optional(),
}).refine(account => account.oauth ? account.password === '' && !account.smtpPassword && !account.smtpUsername : Boolean(account.password))
export function summarizeMailAccount({ password: _password, smtpPassword: _smtpPassword, oauth, ...summary }: MailAccount): MailAccountSummary {
  return { ...summary, ...(oauth ? { oauthProvider: oauth.provider } : {}) }
}
export type MailAccount = z.infer<typeof mailStoredAccount>
export type MailAccountSummary = Omit<MailAccount, 'password' | 'smtpPassword' | 'oauth'> & { oauthProvider?: MailOAuthProvider }
const mailbox = z.string().min(1).max(512).regex(/^[^\r\n\0]*$/)
const accountId = z.uuid()
const messageRef = { mailbox, uid: z.number().int().positive().max(0xffffffff), validity: z.string().regex(/^\d{1,24}$/) }
const sendAttachment = z.object({
  filename: z.string().min(1).max(200).regex(/^[^\\/\p{Cc}\p{Cf}]+$/u),
  content: z.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength <= 10 * 1024 * 1024),
  mimeType: z.string().max(127).regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u),
  cid: z.string().max(128).regex(/^[A-Za-z0-9._-]+$/u).optional(),
}).strict()
const mailDisplayName = z.string().max(160).regex(/^[^\p{Cc}\p{Cf}]*$/u)
const draft = z.object({
  senderName: mailDisplayName.optional(), recipientName: mailDisplayName.optional(),
  cc: z.array(z.email().max(254)).max(19).optional(),
  bcc: z.array(z.email().max(254)).max(19).optional(),
  to: z.array(z.email().max(254)).max(20), subject: z.string().max(998).regex(/^[^\r\n]*$/),
  text: z.string().max(100_000), html: z.string().max(40_000).optional(),
  attachments: z.array(sendAttachment).max(7).optional(),
}).strict().superRefine((value, context) => {
  const attachments = value.attachments ?? []
  const total = attachments.reduce((size, file) => size + file.content.byteLength, 0)
  const inline = attachments.filter(file => file.cid)
  if (attachments.length - inline.length > 5 || inline.length > 2
    || new Set(inline.map(file => file.cid)).size !== inline.length)
    context.addIssue({ code: 'custom', path: ['attachments'], message: '邮件附件数量或内嵌图片无效' })
  if (total > 25 * 1024 * 1024) context.addIssue({ code: 'custom', path: ['attachments'], message: '邮件附件总大小超过限制' })
})
export const mailCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accounts') }),
  z.object({ action: z.literal('inbox'), unreadOnly: z.boolean().optional(), subjectOnly: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional(), query: z.string().trim().max(120).optional(),
    before: z.record(accountId, z.number().int().positive().max(0xffffffff)).optional() }),
  z.object({ action: z.literal('connect'), account: mailAccountInput.extend({ password: z.string().max(512).regex(/^[^\r\n\0]*$/) }), accountId: accountId.optional() }),
  z.object({ action: z.literal('disconnect'), accountId }),
  z.object({ action: z.literal('folders'), accountId }),
  z.object({ action: z.literal('watchInbox'), accountId, watchId: z.uuid(), cursor: z.string().max(160).optional() }).strict(),
  z.object({ action: z.literal('stopInboxWatch'), accountId, watchId: z.uuid() }).strict(),
  z.object({ action: z.literal('messages'), accountId, mailbox, unreadOnly: z.boolean().optional(), subjectOnly: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional(), query: z.string().trim().max(120).optional(), before: z.number().int().positive().max(0xffffffff).optional() }),
  z.object({ action: z.literal('read'), accountId, ...messageRef, remoteImages: z.boolean().optional() }),
  z.object({ action: z.literal('attachment'), accountId, ...messageRef, index: z.number().int().min(0).max(49) }),
  z.object({ action: z.literal('seen'), accountId, ...messageRef, seen: z.boolean() }),
  z.object({ action: z.literal('move'), accountId, ...messageRef, target: z.enum(['archive', 'trash', 'inbox']) }),
  z.object({ action: z.literal('draft'), accountId, draft, replace: z.object(messageRef).optional() }),
  z.object({ action: z.literal('send'), accountId, draft, attemptId: z.uuid(), replyTo: z.object(messageRef).optional() }),
])
export type MailCommand = z.infer<typeof mailCommand>
export const mailDraftLocation = z.object({
  accountId: z.uuid(),
  mailbox: z.string().min(1).max(512).regex(/^[^\p{Cc}]+$/u),
  uid: z.number().int().positive().max(0xffffffff).optional(),
  validity: z.string().regex(/^\d{1,24}$/u).optional(),
}).strict().refine(value => Boolean(value.uid) === Boolean(value.validity))
export type MailDraftLocation = z.infer<typeof mailDraftLocation>

export type MailDraft = z.infer<typeof draft>
export interface MailFolder { path: string; name: string; specialUse: string | null }
export interface MailMessage {
  snippet?: string
  hasAttachments?: boolean
  uid: number; subject: string; from: string; fromName?: string; replyTo: string; to: string[]; date: string | null; seen: boolean
}
export interface MailPage { validity: string; items: MailMessage[]; next: number | null }
export interface MailRead extends MailMessage { text: string; html?: string; unavailableImages?: number; attachments: string[] }

export interface MailAttachment { name: string; data: string }

export interface MailLocatedMessage extends MailMessage {
  accountId: string
  mailbox: string
  validity: string
}
export interface MailInbox {
  items: MailLocatedMessage[]
  unavailableAccountIds: string[]
  next: Record<string, number>
}

export interface MailInboxWatch {
  unreadCount?: number
  cursor: string
  changed: boolean
  idle: boolean
}
