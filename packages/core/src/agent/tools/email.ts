import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Transaction } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import type { Database } from '../../data/schema.js'
import { strip } from '../../shared/values.js'
import type { Json, RunIdentity, ToolCall, ToolResult } from '../models.js'
import type { ToolDefinition, ToolScope } from './contracts.js'
import type { ConfirmationClaimReference, createConfirmationGate, ConfirmationTargetSnapshot } from './confirmation.js'

const schema = z.object({
  to: z.string().max(320).optional(),
  client_id: z.number().int().safe().optional(),
  subject: z.string(),
  body: z.string(),
  format: z.enum(['plain', 'template', 'html']).optional(),
  template: z.enum(['notification', 'reminder', 'report', 'security', 'test']).optional(),
  title: z.string().max(200).optional(),
  preheader: z.string().max(180).optional(),
  sections: z.array(z.object({ heading: z.string().max(120).optional(), text: z.string().min(1).max(5000) }).strict()).max(8).optional(),
  actions: z.array(z.object({ label: z.string().min(1).max(80), url: z.string().min(1).max(2048) }).strict()).max(3).optional(),
  theme: z.enum(['auto', 'light', 'dark']).optional(),
  palette: z.enum(['auto', 'cafe', 'neutral', 'red', 'blue', 'green']).optional(),
  html: z.string().optional(),
  file_paths: z.array(z.string().max(4096).regex(/^\/(personal|project|workspace)\/[^\\\p{Cc}]+$/u).refine(path => path.slice(1).split('/').every(part => part && part !== '.' && part !== '..'))).max(5).optional(),
  file_refs: z.array(z.string().regex(/^[a-f0-9]{24}$/u)).max(5).optional(),
}).strict()
  .refine(value => value.file_paths === undefined || new Set(value.file_paths).size === value.file_paths.length)
  .refine(value => value.file_refs === undefined || new Set(value.file_refs).size === value.file_refs.length)

type EmailInput = z.infer<typeof schema>
type PreparedDraft = Omit<EmailInput, 'to' | 'client_id' | 'file_paths' | 'file_refs' | 'html' | 'format' | 'template'> & {
  recipient: string
  filePaths: readonly string[]
  fileRefs: readonly string[]
  html: string | null
  format: NonNullable<EmailInput['format']>
  template: NonNullable<EmailInput['template']>
}

interface EmailOperation {
  identity: RunIdentity
  roundId: string
  toolCallId: string
}

/** Host 准备时校验附件归属与内容，生成绑定实际邮件、目标及 SMTP 配置版本的快照。 */
interface PreparedEmail {
  snapshot: ConfirmationTargetSnapshot
  /** 确切内容的摘要，包含模板、渲染选项、正文和附件字节的摘要。 */
  digest: string
  /** Host 内部句柄，仅交给发送适配。 */
  delivery: unknown
}

export interface AgentEmailPort {
  confirmation: ReturnType<typeof createConfirmationGate>
  accountEmail(identity: RunIdentity, signal: AbortSignal): Promise<string | null>
  clientEmail(identity: RunIdentity, clientId: number, signal: AbortSignal): Promise<{ email: string | null } | null>
  prepare(operation: EmailOperation, draft: PreparedDraft, signal: AbortSignal): Promise<PreparedEmail | { error: string }>
  /** 发送之前事务内 claim 并持久登记发送尝试。SMTP 回执未知时禁止重发。 */
  send(operation: EmailOperation, prepared: PreparedEmail, claim: ConfirmationClaimReference, signal: AbortSignal): Promise<ToolResult>
  reconcile(operation: EmailOperation): Promise<ToolResult>
  /** 只用于交互恢复，区分尚未发出与已有未知投递。 */
  attempted?(operation: EmailOperation): Promise<boolean>
  supportedFormats?: readonly NonNullable<EmailInput['format']>[]
  supportedAttachmentInputs?: readonly ('file_paths' | 'file_refs')[]
}

export type AgentEmailAutomationClaim = (tx: Transaction<Database>, identity: RunIdentity, signal: AbortSignal) => Promise<boolean>

type AutomatedEmailPort = Omit<AgentEmailPort, 'confirmation' | 'send' | 'attempted'> & {
  sendAutomated(operation: EmailOperation, prepared: PreparedEmail, signal: AbortSignal): Promise<ToolResult>
}

const fail = (error: string): ToolResult => ({ kind: 'completed', successful: false, mutated: false, value: { error } })
const emailPattern = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/u

function normalize(input: EmailInput): Pick<PreparedDraft, 'subject' | 'body' | 'html' | 'format'> | { error: string } {
  const subject = strip(input.subject)
  const body = strip(input.body)
  const html = strip(input.html ?? '') || null
  const format = input.format ?? (html ? 'html' : 'template')
  if (format === 'html' && !html) return { error: 'html 格式必须提供 html 正文和纯文本 body' } as const
  if (format !== 'html' && html) return { error: '只有 format=html 时才能提供 html 正文' } as const
  if (!subject) return { error: '邮件主题不能为空' } as const
  if ([...subject].length > 200) return { error: '邮件主题不能超过 200 个字符' } as const
  if (!body) return { error: '邮件正文不能为空' } as const
  if ([...body].length > 20000) return { error: '邮件正文不能超过 20000 个字符' } as const
  if (html && [...html].length > 40000) return { error: 'HTML 邮件正文不能超过 40000 个字符' } as const
  return { subject, body, html, format } as const
}

function operation(scope: Pick<ToolScope, 'identity' | 'roundId'>, call: ToolCall): EmailOperation {
  return { identity: scope.identity, roundId: scope.roundId, toolCallId: call.id }
}

export function createSendEmailTool(port: AgentEmailPort | AutomatedEmailPort): ToolDefinition {
  const automated = !('confirmation' in port)
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, Json>
  const formats = port.supportedFormats ?? ['plain', 'template', 'html']
  const attachmentInputs = port.supportedAttachmentInputs ?? ['file_paths']
  const defaultFormat = formats.includes('template') ? 'template' : formats[0] ?? 'plain'
  const properties: Record<string, Json> = { ...parameters.properties as Record<string, Json>, format: { type: 'string', enum: [...formats] } }
  if (!attachmentInputs.includes('file_paths')) delete properties.file_paths
  if (attachmentInputs.includes('file_refs')) {
    properties.file_refs = { type: 'array', maxItems: 5, uniqueItems: true, items: {
      type: 'string', pattern: '^[a-f0-9]{24}$', description: '当前消息【引用文件】中的引用键。',
    } }
  } else delete properties.file_refs
  if (!formats.includes('html')) delete properties.html
  return {
    definition: { name: 'send_email', schema: { type: 'function', function: {
      name: 'send_email',
      description: automated ? '发送当前定时任务已预先授权的邮件，缺省收件人为当前用户注册邮箱。'
        : '发送邮件，缺省收件人为当前用户注册邮箱。发送前需要确认。',
      parameters: { ...parameters, properties, not: { required: ['to', 'client_id'] } },
    } } },
    effect: 'write', destructive: true, ...(automated ? {} : { requiresInteraction: true, confirmationReplay: true }),
    strictArrayFields: ['file_paths', 'file_refs', 'sections', 'actions'],
    validate: input => schema.safeParse(input),
    reconcile(_input, identity, call) {
      return port.reconcile({ identity, roundId: identity.roundId, toolCallId: call.id })
    },
    async execute(input, scope, call) {
      const id = operation(scope, call)
      const { identity, signal } = scope
      signal.throwIfAborted()
      if (!automated && scope.resolution?.status === 'confirmed') {
        const previous = await port.reconcile(id)
        // 只有 Host 能区分从未尝试和发送结果未知。后者由 send 的持久认领拦截。
        if (previous.kind === 'completed' || await port.attempted?.(id)) return previous
      }
      const { to, client_id, file_paths, file_refs, ...inputDraft } = input as EmailInput
      const filePaths = file_paths ?? []
      const fileRefs = file_refs ?? []
      if (filePaths.length && !attachmentInputs.includes('file_paths')) return fail('当前邮件端口不支持文件路径附件')
      if (fileRefs.length && !attachmentInputs.includes('file_refs')) return fail('当前邮件端口不支持本机文件引用附件')
      const normalized = normalize({
        ...inputDraft,
        format: inputDraft.format ?? (strip(inputDraft.html ?? '') ? 'html' : defaultFormat),
      })
      if ('error' in normalized) return fail(normalized.error)
      if (!formats.includes(normalized.format)) return fail('当前邮件端口不支持此格式')
      const explicit = strip(to ?? '')
      if (explicit && client_id !== undefined) return fail('to 与 client_id 不能同时指定')
      let recipient = explicit
      if (client_id !== undefined) {
        const client = await port.clientEmail(identity, client_id, signal)
        if (!client) return fail('联系人不存在')
        recipient = strip(client.email ?? '')
        if (!recipient) return fail('该联系人没有邮箱地址')
      } else if (!recipient) {
        recipient = strip(await port.accountEmail(identity, signal) ?? '')
      }
      signal.throwIfAborted()
      if (!emailPattern.test(recipient)) return fail('收件人邮箱格式无效')
      const prepared = await port.prepare(id, {
        ...inputDraft, ...normalized, recipient, template: inputDraft.template ?? 'notification', filePaths, fileRefs,
      }, signal)
      signal.throwIfAborted()
      if ('error' in prepared) return fail(prepared.error)
      if (automated) return port.sendAutomated(id, prepared, signal)
      if (!scope.resolution) {
        const result = await port.confirmation.prepare(call, scope, prepared.digest, prepared.snapshot)
        return result.ok ? { kind: 'waiting', interaction: result.value } : fail('邮件发送确认无效或已过期')
      }
      const result = await port.confirmation.verify(call, scope, prepared.digest, prepared.snapshot)
      if (!result.ok) return fail('邮件发送内容已改变或确认无效')
      return port.send(id, prepared, result.value, signal)
    },
  }
}

type EmailOutcome = Extract<ToolResult, { kind: 'completed' }>
const noReceipt = new Error('邮件投递收据不存在')
const notClaimed = new Error('邮件发送确认未能认领')

/** 先持久记下一次尝试，再访问 SMTP。进程退出或提交结果未知时，恢复路径只查询收据。 */
export function createDurableAgentEmailDelivery(core: SqlDataRuntime, options: {
  claim?(tx: Transaction<Database>, claim: ConfirmationClaimReference, signal: AbortSignal): Promise<boolean>
  deliver(prepared: unknown, signal: AbortSignal): Promise<EmailOutcome | { kind: 'unknown' }>
}): Pick<AgentEmailPort, 'send' | 'reconcile' | 'attempted'> & {
  sendAutomated(operation: EmailOperation, prepared: PreparedEmail, signal: AbortSignal, claim: AgentEmailAutomationClaim): Promise<ToolResult>
} {
  if (!core.receipts) throw new Error('邮件投递需要持久操作收据')
  function coordinate(operation: EmailOperation, stage: 'attempt' | 'outcome') {
    const context = dataContext(operation.identity.ownerId)
    const key = [context.ownerId, operation.identity.sessionId, operation.identity.runId, operation.roundId, operation.toolCallId]
    if (key.some(value => !value.trim())) throw new Error('邮件运行身份无效')
    const method = `agent.email.${stage}`
    const hex = createHash('sha256').update(JSON.stringify([method, ...key])).digest('hex')
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    return { context, method, id }
  }

  async function read<T>(operation: EmailOperation, stage: 'attempt' | 'outcome'): Promise<T | null> {
    const { context, id, method } = coordinate(operation, stage)
    try {
      return (await core.operationWithTransaction<T>(context, id, method, {}, async () => { throw noReceipt })).result
    } catch (error) {
      if (error === noReceipt) return null
      throw error
    }
  }
  async function reconcile(operation: EmailOperation): Promise<ToolResult> {
    const outcome = await read<EmailOutcome>(operation, 'outcome')
    return outcome ? { ...outcome, mutated: false } : { kind: 'unknown' }
  }

  async function sendOnce(operation: EmailOperation, prepared: PreparedEmail, signal: AbortSignal,
    authorize: (tx: Transaction<Database>) => Promise<boolean>, denial: string): Promise<ToolResult> {
    signal.throwIfAborted()
    const attempt = coordinate(operation, 'attempt')
    try {
      const receipt = await core.operationWithTransaction(attempt.context, attempt.id, attempt.method, {}, async tx => {
        signal.throwIfAborted()
        if (!await authorize(tx)) throw notClaimed
        return { started: true }
      }, { signal })
      if (receipt.replayed) return reconcile(operation)
    } catch (error) {
      return error === notClaimed ? fail(denial) : { kind: 'unknown' }
    }
    if (signal.aborted) return { kind: 'unknown' }
    try {
      const result = await options.deliver(prepared.delivery, signal)
      if (result.kind === 'unknown') return result
      const outcome = coordinate(operation, 'outcome')
      // SMTP 已产生外部结果，即便 Run 随即取消也要保存结果。
      const settled = await core.operationWithTransaction(outcome.context, outcome.id, outcome.method, {}, async () => result)
      return settled.result
    } catch {
      return { kind: 'unknown' }
    }
  }

  return {
    reconcile,
    async attempted(operation) {
      return await read<{ started: true }>(operation, 'attempt') !== null
    },
    sendAutomated(operation, prepared, signal, claim) {
      return sendOnce(operation, prepared, signal, tx => claim(tx, operation.identity, signal), '定时任务邮件预授权已失效')
    },
    async send(operation, prepared, claim, signal) {
      signal.throwIfAborted()
      const binding = claim.binding
      const { identity } = operation
      if (binding.ownerId !== identity.ownerId || binding.sessionId !== identity.sessionId || binding.runId !== identity.runId
        || binding.roundId !== operation.roundId || binding.toolCallId !== operation.toolCallId
        || binding.toolName !== 'send_email' || claim.action !== 'send_email' || claim.purpose !== 'action'
        || binding.normalizedInputDigest !== prepared.digest || claim.targetsDigest !== prepared.snapshot.targetsDigest
        || claim.versionsDigest !== prepared.snapshot.versionsDigest)
        return fail('邮件发送确认与当前内容不匹配')
      return sendOnce(operation, prepared, signal, tx => options.claim?.(tx, claim, signal) ?? Promise.resolve(false), '邮件发送确认已使用或失效')
    },
  }
}
