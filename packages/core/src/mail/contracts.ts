import { z } from 'zod'

export const mailPresets = {
  qq: { imapHost: 'imap.qq.com', smtpHost: 'smtp.qq.com', smtpPort: 465 },
  '163': { imapHost: 'imap.163.com', smtpHost: 'smtp.163.com', smtpPort: 465 },
  '126': { imapHost: 'imap.126.com', smtpHost: 'smtp.126.com', smtpPort: 465 },
  yeah: { imapHost: 'imap.yeah.net', smtpHost: 'smtp.yeah.net', smtpPort: 465 },
  icloud: { imapHost: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
} as const

const host = z.string().trim().toLowerCase().max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
export const mailAccountInput = z.object({
  email: z.email().max(254), username: z.string().trim().min(1).max(254).regex(/^[^\r\n\0]*$/),
  password: z.string().min(1).max(512).regex(/^[^\r\n\0]*$/),
  imapHost: host, smtpHost: host, smtpPort: z.union([z.literal(465), z.literal(587)]),
}).strict()
export const mailStoredAccount = mailAccountInput.extend({ id: z.uuid() })
export type MailAccount = z.infer<typeof mailStoredAccount>
export type MailAccountSummary = Omit<MailAccount, 'password'>
const mailbox = z.string().min(1).max(512).regex(/^[^\r\n\0]*$/)
const accountId = z.uuid()
const messageRef = { mailbox, uid: z.number().int().positive().max(0xffffffff), validity: z.string().regex(/^\d{1,24}$/) }
const sendAttachment = z.object({
  filename: z.string().min(1).max(200).regex(/^[^\\/\p{Cc}\p{Cf}]+$/u),
  content: z.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength <= 10 * 1024 * 1024),
  mimeType: z.string().max(127).regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u),
  cid: z.string().max(128).regex(/^[A-Za-z0-9._-]+$/u).optional(),
}).strict()
const draft = z.object({
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
  z.object({ action: z.literal('connect'), account: mailAccountInput, accountId: accountId.optional() }),
  z.object({ action: z.literal('disconnect'), accountId }),
  z.object({ action: z.literal('folders'), accountId }),
  z.object({ action: z.literal('messages'), accountId, mailbox, query: z.string().trim().max(120).optional(), before: z.number().int().positive().max(0xffffffff).optional() }),
  z.object({ action: z.literal('read'), accountId, ...messageRef }),
  z.object({ action: z.literal('attachment'), accountId, ...messageRef, index: z.number().int().min(0).max(49) }),
  z.object({ action: z.literal('seen'), accountId, ...messageRef, seen: z.boolean() }),
  z.object({ action: z.literal('move'), accountId, ...messageRef, target: z.enum(['archive', 'trash', 'inbox']) }),
  z.object({ action: z.literal('draft'), accountId, draft, replace: z.object(messageRef).optional() }),
  z.object({ action: z.literal('send'), accountId, draft, attemptId: z.uuid(), replyTo: z.object(messageRef).optional() }),
])
export type MailCommand = z.infer<typeof mailCommand>
export type MailDraft = z.infer<typeof draft>
export interface MailFolder { path: string; name: string; specialUse: string | null }
export interface MailMessage {
  uid: number; subject: string; from: string; replyTo: string; to: string[]; date: string | null; seen: boolean
}
export interface MailPage { validity: string; items: MailMessage[]; next: number | null }
export interface MailRead extends MailMessage { text: string; attachments: string[] }

export interface MailAttachment { name: string; data: string }
