import { sanitizeEmailHtml } from '../../../src/email/html.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { expect, it, vi } from 'vitest'
import { createConfirmationGate, type ConfirmationIntent, type ConfirmationClaimReference } from '../../../src/agent/tools/confirmation.js'
import { createSendEmailTool, createDurableAgentEmailDelivery } from '../../../src/agent/tools/email.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ToolScope } from '../../../src/agent/tools/contracts.js'

it('邮件默认使用可信账号邮箱，确认绑定邮件内容和附件版本，重放只读收据', async () => {
  const identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }
  const scope = { identity, roundId: 'round-a', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('不执行 Shell') } }
  let intent: ConfirmationIntent | undefined
  let version = 'v1'
  let sent = false
  const confirmation = createConfirmationGate({
    now: () => 10,
    authorize: async () => 'permission',
    async prepare(binding, snapshot) {
      intent = { schemaVersion: 2, binding, intentId: 'intent-a', interactionId: 'interaction-a', operationId: 'op-a',
        purpose: 'action', action: 'send_email', authorizationEpoch: 'permission', expiresAt: 100,
        targetsDigest: snapshot.targetsDigest, versionsDigest: snapshot.versionsDigest }
      return intent
    },
    async inspect() { return intent ? { targetsDigest: intent.targetsDigest, versionsDigest: intent.versionsDigest } : null },
    async load() {
      return intent ? { intent, receipt: {
        schemaVersion: 2, intentId: intent.intentId, interactionId: intent.interactionId, receiptId: 'receipt-a',
        binding: intent.binding, purpose: intent.purpose, action: intent.action, status: 'approved', expiresAt: 100,
      } } : null
    },
  }, { purpose: 'action', action: 'send_email' })
  const accepted = { kind: 'completed', successful: true, mutated: true, value: { status: 'sent', delivery: 'smtp_accepted' } } as const
  const send = vi.fn(async () => { sent = true; return accepted })
  const prepare = vi.fn<Parameters<typeof createSendEmailTool>[0]['prepare']>(async (_operation, draft) => ({
    digest: JSON.stringify(draft), snapshot: { targetsDigest: 'owner-recipient', versionsDigest: version }, delivery: draft,
  }))
  const emailTool = createSendEmailTool({
    confirmation, accountEmail: async () => 'owner@example.com', clientEmail: async () => null, prepare, send,
    async reconcile() { return sent ? { ...accepted, mutated: false } : { kind: 'unknown' } },
  })
  expect(emailTool.destructive).toBe(true)
  const registry = createToolRegistry({
    authorize: async candidate => candidate.ownerId === identity.ownerId,
    confirmationGatedDestructiveTools: [emailTool],
  })
  const call = { name: 'send_email', id: 'call-a', input: { subject: ' 计划 ', body: ' 正文 ', file_ids: [3] } }
  expect(await registry.tools.dispatch({ ...call, input: { ...call.input, client_id: 9 } }, scope)).toMatchObject({ value: { error: '联系人不存在' } })
  expect(await registry.tools.dispatch(call, scope)).toMatchObject({ kind: 'waiting' })
  expect(prepare.mock.calls[0]?.[1]).toMatchObject({ recipient: 'owner@example.com', subject: '计划', body: '正文', format: 'template', fileIds: [3] })
  expect(send).not.toHaveBeenCalled()

  const resume = { ...scope, resolution: { status: 'confirmed' as const, interactionId: 'interaction-a', receiptId: 'receipt-a', value: null } }
  version = 'v2'
  expect(await registry.tools.dispatch(call, resume)).toMatchObject({ successful: false })
  expect(send).not.toHaveBeenCalled()
  version = 'v1'
  expect(await registry.tools.dispatch(call, resume)).toEqual(accepted)
  expect(await registry.tools.dispatch(call, resume)).toMatchObject({ successful: true, mutated: false })
  expect(send).toHaveBeenCalledTimes(1)
})

it('格式省略时选择当前宿主支持的默认邮件格式', async () => {
  const delivered: unknown[] = []
  const tool = createSendEmailTool({
    supportedFormats: ['plain'],
    async accountEmail() { return 'owner@example.com' },
    async clientEmail() { return null },
    async prepare(_operation, draft) {
      return { digest: 'draft', snapshot: { targetsDigest: 'target', versionsDigest: 'version' }, delivery: draft }
    },
    async reconcile() { return { kind: 'unknown' } },
    async sendAutomated(_operation, prepared) {
      delivered.push(prepared)
      return { kind: 'completed', successful: true, mutated: true, value: { status: 'sent' } }
    },
  })
  const scope: ToolScope = {
    identity: { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }, roundId: 'round-a',
    signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('不执行 Shell') },
  }

  const result = await tool.execute({ subject: '主题', body: '正文' }, scope, { name: 'send_email', id: 'call-a', input: { subject: '主题', body: '正文' } })

  expect(result).toMatchObject({ kind: 'completed', successful: true })
  expect(delivered[0]).toMatchObject({
    delivery: { recipient: 'owner@example.com', subject: '主题', body: '正文', format: 'plain' },
  })
})

it('桌面邮件 Schema 只公开本机文件引用并把授权引用交给 Host 准备端口', async () => {
  let prepared: unknown
  const tool = createSendEmailTool({
    supportedFormats: ['plain', 'template', 'html'],
    supportedAttachmentInputs: ['file_refs'],
    async accountEmail() { return 'owner@example.com' },
    async clientEmail() { return null },
    async prepare(_operation, draft) {
      prepared = draft
      return { digest: 'draft', snapshot: { targetsDigest: 'target', versionsDigest: 'version' }, delivery: draft }
    },
    async reconcile() { return { kind: 'unknown' } },
    async sendAutomated() { return { kind: 'completed', successful: true, mutated: true, value: { status: 'sent' } } },
  })
  const properties = (tool.definition.schema.function.parameters as { properties: Record<string, unknown> }).properties
  expect(properties).toHaveProperty('file_refs')
  expect(properties).not.toHaveProperty('file_ids')
  const scope: ToolScope = {
    identity: { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }, roundId: 'round-a',
    signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('不执行 Shell') },
  }
  const result = await tool.execute({ subject: '主题', body: '正文', file_refs: ['a'.repeat(24)] }, scope,
    { name: 'send_email', id: 'call-a', input: { subject: '主题', body: '正文', file_refs: ['a'.repeat(24)] } })
  expect(result).toMatchObject({ kind: 'completed', successful: true })
  expect(prepared).toMatchObject({ fileRefs: ['a'.repeat(24)], format: 'template' })
})

it('SMTP 结果未知时保留持久尝试收据，重新装配和并发重试均不重发', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-email-receipt-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    const path = join(directory, 'email.db')
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const identity = { ownerId: opened.ownerId, sessionId: '1', runId: 'email-run' }
    const operation = { identity, roundId: 'round-a', toolCallId: 'email-call' }
    const draft = { snapshot: { targetsDigest: 'target', versionsDigest: 'version' }, digest: 'draft', delivery: '邮件正文' }
    const claim: ConfirmationClaimReference = {
      binding: { ...identity, roundId: operation.roundId, toolCallId: operation.toolCallId,
        toolName: 'send_email', normalizedInputDigest: draft.digest },
      intentId: 'intent', operationId: 'op', interactionId: 'interaction', receiptId: 'receipt',
      purpose: 'action', action: 'send_email', authorizationEpoch: 'auth', expiresAt: 100,
      targetsDigest: draft.snapshot.targetsDigest, versionsDigest: draft.snapshot.versionsDigest,
    }
    const signal = new AbortController().signal
    const runClaim = vi.fn(async () => true)
    const deliver = vi.fn(async () => ({ kind: 'unknown' as const }))
    const options = { claim: runClaim, deliver }
    const port = createDurableAgentEmailDelivery(runtime, options)
    expect(await port.attempted!(operation)).toBe(false)
    expect(await port.send(operation, { ...draft, digest: 'changed' }, claim, signal)).toMatchObject({ successful: false })
    expect(runClaim).not.toHaveBeenCalled()
    expect(await Promise.all([port.send(operation, draft, claim, signal), port.send(operation, draft, claim, signal)]))
      .toEqual([{ kind: 'unknown' }, { kind: 'unknown' }])
    const rebuilt = createDurableAgentEmailDelivery(runtime, options)
    expect(await rebuilt.attempted!(operation)).toBe(true)
    expect(await rebuilt.reconcile(operation)).toEqual({ kind: 'unknown' })
    expect(await rebuilt.send(operation, draft, claim, signal)).toEqual({ kind: 'unknown' })
    expect(runClaim).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  } finally {
    await runtime?.close()
    await rm(directory, { force: true, recursive: true })
  }
})

it('邮件 HTML 保留安全表格与链接，移除脚本、远程图片及混淆的外部 CSS', () => {
  const html = sanitizeEmailHtml(
    '<table role="presentation" width="100%"><tr><td valign="middle" style="text-align:center;color:#abc">内容</td></tr></table>'
    + '<script>敏感脚本</script><svg><title>外部标记</title></svg>'
    + '<a href="jav&#x61;script:alert(1)" onclick="bad()">安全文本</a>'
    + '<a href="https://example.com/?a=1&amp;b=2">正常链接</a>'
    + '<img src="cid:logo"><img src="https://example.com/remote.png"><img src="data:image/png;base64,AAAA">'
    + '<p style="background:u/**/rl(https://example.com/x)">保留正文</p>',
  )
  expect(html).toContain('role="presentation" width="100%"')
  expect(html).toContain('valign="middle" style="text-align:center;color:#abc"')
  expect(html).toContain('<a>安全文本</a>')
  expect(html).toContain('href="https://example.com/?a=1&amp;b=2"')
  expect(html).toContain('src="cid:logo"')
  expect(html).toContain('<p>保留正文</p>')
  expect(html).not.toMatch(/敏感脚本|外部标记|javascript:|onclick|remote.png|data:image|background:/u)
})

it('定时邮件撤权时不写尝试收据，结果未知后同一调用禁止重发', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-scheduled-email-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    const path = join(directory, 'email.db')
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const operation = {
      identity: { ownerId: opened.ownerId, sessionId: 'scheduled-task:42', runId: 'email-run' },
      roundId: 'round-a', toolCallId: 'email-call',
    }
    const draft = { snapshot: { targetsDigest: 'target', versionsDigest: 'version' }, digest: 'draft', delivery: '合成邮件' }
    const signal = new AbortController().signal
    const deliver = vi.fn(async () => ({ kind: 'unknown' as const }))
    const port = createDurableAgentEmailDelivery(runtime, { deliver })
    expect(await port.sendAutomated(operation, draft, signal, async () => false))
      .toMatchObject({ successful: false, mutated: false, value: { error: '定时任务邮件预授权已失效' } })
    expect(await port.attempted!(operation)).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
    const claim = vi.fn(async () => true)
    expect(await port.sendAutomated(operation, draft, signal, claim)).toEqual({ kind: 'unknown' })
    const rebuilt = createDurableAgentEmailDelivery(runtime, { deliver })
    expect(await rebuilt.sendAutomated(operation, draft, signal, claim)).toEqual({ kind: 'unknown' })
    expect(claim).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  } finally {
    await runtime?.close()
    await rm(directory, { force: true, recursive: true })
  }
})
