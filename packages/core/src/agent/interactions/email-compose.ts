import { z } from 'zod'

const name = z.string().trim().max(160).regex(/^[^\p{Cc}\p{Cf}]*$/u)
const addresses = z.array(z.email().max(254)).max(19)
const submission = z.object({
  account: z.uuid().optional(),
  senderAddress: z.string().max(254).optional(),
  action: z.enum(['send', 'draft']),
  recipient: z.union([z.email().max(254), z.literal('')]),
  additionalRecipients: addresses.optional(),
  cc: addresses.optional(),
  bcc: addresses.optional(),
  senderName: name,
  recipientName: name,
  subject: z.string().trim().max(200).regex(/^[^\r\n]*$/u),
  text: z.string().max(20_000),
  html: z.string().max(40_000).optional(),
}).strict().refine(value => value.action === 'draft' || Boolean(value.recipient && value.subject && value.text.trim()))

export type EmailComposeSubmission = z.infer<typeof submission>

export function parseEmailComposeSubmission(value: unknown): EmailComposeSubmission | null {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 80_000) return null
  try { return validateEmailComposeSubmission(JSON.parse(value)) } catch { return null }
}

export function validateEmailComposeSubmission(value: unknown): EmailComposeSubmission | null {
  const parsed = submission.safeParse(value)
  return parsed.success ? parsed.data : null
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function projectEmailCompose(context: Record<string, unknown>, resolved: Record<string, unknown>) {
  const initial = object(context.email_compose)
  if (context.tool_name !== 'send_email' || initial.enabled !== true) return undefined
  const submission = validateEmailComposeSubmission(resolved.email_submission)
  if (!submission) return initial
  if (initial.format === 'html' || initial.format === 'template' || initial.templateHtml)
    return { ...initial, submittedAction: submission.action }
  const accounts = Array.isArray(initial.accounts) ? initial.accounts.map(object) : []
  const sender = accounts.find(account => account.id === submission.account)
  return {
    ...initial, account: submission.account, sender: sender?.email ?? initial.sender,
    submittedAction: submission.action,
    senderName: submission.senderName, recipientName: submission.recipientName,
    recipient: [submission.recipient, ...submission.additionalRecipients ?? []].join(', '),
    cc: submission.cc?.join(', '), bcc: submission.bcc?.join(', '),
    subject: submission.subject, text: submission.text,
  }
}

/** 历史卡只需要终态和定位草稿的引用，工具完整结果仍通过 owner 限定的详情入口读取。 */
export function projectEmailComposeReceipt(value: unknown) {
  const receipt = object(value)
  if (receipt.status === 'draft_saved') {
    const ref = object(receipt.draftRef)
    const draftRef = typeof ref.accountId === 'string' && typeof ref.mailbox === 'string'
      ? { accountId: ref.accountId, mailbox: ref.mailbox,
        ...(typeof ref.uid === 'number' && typeof ref.validity === 'string' ? { uid: ref.uid, validity: ref.validity } : {}) }
      : undefined
    return { status: receipt.status, ...(draftRef ? { draftRef } : {}) }
  }
  if (receipt.status === 'sent' || receipt.status === 'partial') return { status: receipt.status }
  if (typeof receipt.error === 'string') return { error: receipt.error.slice(0, 240) }
  return undefined
}
