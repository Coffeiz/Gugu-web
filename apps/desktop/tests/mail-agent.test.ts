import { consumeSqliteInteraction } from '../../../packages/core/src/agent/interactions/sqlite-consume.js'
import { createHash } from 'node:crypto'
import { sql } from 'kysely'
import { initializeSqlite, openSqliteRuntime } from '../../../packages/core/src/data/sqlite.js'
import { createSqliteInteractionActivator } from '../../../packages/core/src/agent/interactions/sqlite-activate.js'
import { desktopFileReferenceKey } from '../../../packages/core/src/agent/sessions/desktop-references.js'
import { createDesktopEmailTool } from '../src/main/agent/runtime/email-tools.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderSmtpDraftMessage } from '@gugu/core/email/smtp-test'
import { DESKTOP_CHANNELS, MAX_FRAME } from '@gugu/core/desktop'
import type { MailTransport } from '@gugu/email/service'
import { afterEach, describe, expect, it } from 'vitest'
import { desktopMailAttachmentDigest } from '../src/main/mail/attachments.js'
import { createDesktopMailService } from '../src/main/mail/index.js'

describe('桌面 Agent 邮件宿主端口', () => {
  const directories: string[] = []
  afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

  it.each(['im', 'send', 'draft', 'html'] as const)('桌面邮件确认与实际回复（%s）', async mode => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-mail-confirm-'))
    directories.push(directory)
    const database = join(directory, 'core.db')
    await initializeSqlite(database)
    const { runtime, ownerId } = await openSqliteRuntime(database)
    const db = runtime.db
    const owner = ownerId.replaceAll('-', '')
    const identity = { ownerId, sessionId: '1', runId: 'run-email' }
    const reference = 'drop-synthetic-ref'
    const account = '00000000-0000-4000-8000-000000000001'
    const time = new Date().toISOString()
    const deliveries: unknown[] = []
    try {
      await sql`INSERT INTO conversation_sessions (id,user_id,title,title_locked,summary,context_epoch,created_at,updated_at)
        VALUES (1,${owner},'合成会话',0,'',0,${time},${time})`.execute(db)
      await sql`INSERT INTO conversation_messages (id,session_id,conversation_seq,role,content,references_json,created_at)
        VALUES (1,1,1,'user','准备邮件',${JSON.stringify([{ type: 'file', id: reference }])},${time})`.execute(db)
      await sql`INSERT INTO agent_run_admissions (user_id,session_id,run_id,user_message_id)
        VALUES (${owner},1,${identity.runId},1)`.execute(db)
      await sql`INSERT INTO agent_run_checkpoints (user_id,session_id,run_id,version,sequence,status,phase,nonce,payload)
        VALUES (${owner},1,${identity.runId},1,0,'running','tools',X'00',X'00')`.execute(db)
      const { sendEmail, emailConfirmation } = createDesktopEmailTool({
        core: runtime, ownerId, enabled: true, imConfirmation: mode === 'im', authorize: async () => true, authorizeWrite: async () => true,
        digest: value => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
        async hostRequest(method, params) {
          if (method === 'agent.email.accounts')
            return [{ id: account, email: 'sender@example.test', version: 'a'.repeat(64), receiveOnly: false }]
          if (method === 'agent.email.attachments')
            return { digest: 'b'.repeat(64), items: [{ filename: '资料.txt', mimeType: 'text/plain', size: 4 }] }
          if (method === 'agent.email.send' && mode !== 'im') {
            deliveries.push(params)
            return mode === 'draft' ? { ok: true } : { partial: false }
          }
          throw new Error('等待确认阶段不得投递')
        },
      })
      const signal = AbortSignal.timeout(10_000)
      const format = mode === 'html' ? 'html' : mode === 'send' ? 'plain' : 'template'
      const call = { name: 'send_email', id: 'call-email', input: {
        account, subject: '合成主题', body: '合成正文', format, ...(format === 'html' ? { html: '<p><strong>原始 HTML</strong></p>' } : {}), sections: [{ heading: '分段标题', text: '分段内容' }],
        actions: [{ label: '查看详情', url: 'https://example.test/report' }], file_refs: [desktopFileReferenceKey(reference)],
      } }
      const result = await sendEmail!.execute(call.input, {
        identity, roundId: 'round-email', signal, resolution: null, execute: async () => { throw new Error('不执行 Shell') },
      }, call)
      expect(result.kind).toBe('waiting')
      if (result.kind !== 'waiting') return
      const interactions = createSqliteInteractionActivator(db, { describe: emailConfirmation!.describe })
      await interactions.activate(identity, result.interaction, signal)
      const { rows: [prompt] } = await sql<{ title: string; body: string }>`SELECT title,body FROM interaction_prompts`.execute(db)
      if (format === 'template') expect(prompt?.body).toContain('合成正文\n\n分段标题\n分段内容\n查看详情：https://example.test/report')
      expect(prompt).toMatchObject({ title: '请确认发送邮件', body: expect.stringContaining('资料.txt') })
      expect(deliveries).toHaveLength(0)
      if (mode === 'im') return
      const { rows: [form] } = await sql<{ id: number; schema_json: string }>`SELECT id,schema_json FROM interaction_prompts`.execute(db)
      expect(JSON.parse(form!.schema_json).context.email_compose).toMatchObject({
        enabled: true, recipient: 'sender@example.test', sender: 'sender@example.test',
        format,
        ...(format === 'plain' ? {} : { templateHtml: expect.stringContaining(format === 'html' ? '<strong>原始 HTML</strong>' : 'data:image/png;base64,') }),
      })
      const token = 'synthetic-mail-option'
      const hash = createHash('sha256').update(token).digest('hex')
      await sql`UPDATE interaction_actions SET token_hash=${hash} WHERE prompt_id=${form!.id} AND option_id='confirm'`.execute(db)
      await sql`UPDATE agent_run_checkpoints SET status='waiting' WHERE run_id=${identity.runId}`.execute(db)
      await expect(consumeSqliteInteraction(db, identity, form!.id, { token }, 'synthetic-missing-mail-form'))
        .rejects.toMatchObject({ code: 'action_invalid' })
      expect(deliveries).toHaveLength(0)
      const edit = { action: mode === 'draft' ? 'draft' : 'send', account, recipient: 'recipient@example.test',
        cc: ['copy@example.test'], bcc: ['blind@example.test'],
        senderName: '小北', recipientName: '小南', subject: '改写主题', text: '改写正文', html: '<p>改写正文</p>' }
      const { resolution } = await consumeSqliteInteraction(db, identity, form!.id,
        { token, customAnswer: JSON.stringify(edit) }, 'synthetic-mail-submission')
      expect(resolution).toMatchObject({ status: 'confirmed', value: null })
      const scope = { identity, roundId: 'round-email', signal, resolution, execute: async () => { throw new Error('不执行 Shell') } }
      const sent = await sendEmail!.execute(call.input, scope, call)
      expect(sent).toMatchObject({ kind: 'completed', successful: true, value: { status: mode === 'draft' ? 'draft_saved' : 'sent' } })
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]).toMatchObject({ accountId: account,
        draft: format === 'plain'
          ? { to: ['recipient@example.test'], subject: '改写主题', text: '改写正文', html: '<p>改写正文</p>' }
          : { to: ['sender@example.test'], subject: '合成主题', text: expect.stringContaining('合成正文'),
            html: expect.stringContaining(format === 'html' ? '<strong>原始 HTML</strong>' : 'cid:gugu-logo-mark') },
      })
      expect(await sendEmail!.execute(call.input, scope, call)).toMatchObject({ kind: 'completed', mutated: false })
      expect(deliveries).toHaveLength(1)
    } finally {
      await runtime.close()
    }
  })

  it('重启后按账户、邮箱及 UIDVALIDITY 复用正文，加载图片时不重新读取邮箱', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-mail-cache-'))
    directories.push(directory)
    let reads = 0
    const transport: MailTransport = {
      async loadImages(message) { return { ...message, text: '图片已补齐', unavailableImages: 0 } },
      async verify() {},
      async execute(_account, command) {
        if (command.action === 'messages')
          return { validity: '7', items: [{ uid: 1 }, { uid: 2 }], next: null }
        return { uid: 1, subject: '合成邮件', text: String(++reads), attachments: [],
          ...(command.action === 'read' && command.remoteImages ? { unavailableImages: 0 } : {}) }
      },
    }
    const encryption = {
      async isAsyncEncryptionAvailable() { return true },
      async encryptStringAsync(value: string) { return Buffer.from(value) },
      async decryptStringAsync(value: Buffer) { return { result: value.toString('utf8'), shouldReEncrypt: false } },
    }
    const create = () => createDesktopMailService(directory, encryption, transport).handlers[DESKTOP_CHANNELS.mail]!
    const first = create()
    const account = await first({ action: 'connect', account: {
      email: 'sender@example.test', username: 'sender', password: 'synthetic-secret',
      imapHost: 'imap.example.test', smtpHost: 'smtp.example.test', smtpPort: 465,
    } }) as { id: string }
    const command = { action: 'read', accountId: account.id, mailbox: 'INBOX', uid: 1, validity: '7' }
    expect(await first(command)).toMatchObject({ text: '1' })
    const reopened = create()
    expect(await reopened({ action: 'messages', accountId: account.id, mailbox: 'INBOX' }))
      .toMatchObject({ items: [{ uid: 1, snippet: '1' }, { uid: 2 }] })
    expect(await reopened({ action: 'inbox' })).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ accountId: account.id, uid: 1, snippet: '1' })]),
    })
    expect(reads).toBe(1)
    expect(await reopened(command)).toMatchObject({ text: '1' })
    expect(await reopened({ ...command, remoteImages: true })).toMatchObject({ text: '图片已补齐' })
    expect(await create()(command)).toMatchObject({ text: '图片已补齐', unavailableImages: 0 })
    expect(await create()({ ...command, remoteImages: true })).toMatchObject({ text: '图片已补齐', unavailableImages: 0 })
    expect(await reopened({ ...command, validity: '8' })).toMatchObject({ text: '2' })
    await reopened({ action: 'disconnect', accountId: account.id })
    await expect(reopened(command)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('只返回脱敏账户信息，绑定账户版本并按尝试 ID 阻止重复发送', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-agent-mail-'))
    directories.push(directory)
    const sends: unknown[] = []
    const transport: MailTransport = {
      async verify() {},
      async execute(_account, command) {
        sends.push(command)
        if (command.action === 'read') return { text: '合成正文', attachments: [] }
        if (command.action === 'draft') return { ok: true }
        if (command.action === 'messages') return { validity: '1', next: null, items: [
          { uid: 1, subject: '合成邮件', from: 'sender@example.test', replyTo: '', to: [], date: '2026-01-02T00:00:00Z', seen: false },
          { uid: 2, subject: '未返回的邮件', from: 'sender@example.test', replyTo: '', to: [], date: null, seen: false },
        ] }
        return { partial: false }
      },
    }
    const encryption = {
      async isAsyncEncryptionAvailable() { return true },
      async encryptStringAsync(value: string) { return Buffer.from(value) },
      async decryptStringAsync(value: Buffer) { return { result: value.toString('utf8'), shouldReEncrypt: false } },
    }
    const service = createDesktopMailService(directory, encryption, transport)
    const connect = service.handlers[DESKTOP_CHANNELS.mail]
    await connect({ action: 'connect', account: {
      email: 'sender@example.test', username: 'sender', password: 'synthetic-secret',
      imapHost: 'imap.example.test', smtpHost: 'smtp.example.test', smtpPort: 465,
    } })
    const [account] = await service.listAccounts()
    expect(account).toMatchObject({ email: 'sender@example.test', version: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(account).not.toHaveProperty('password')
    await expect(service.listForAgent({ account: 'all', query: '合成', limit: 1 })).resolves.toEqual({
      items: [{ account: account!.id, subject: '合成邮件', from: 'sender@example.test', from_name: '', date: '2026-01-02T00:00:00Z', seen: true, snippet: '合成正文' }],
      unavailable_accounts: [], marked_read: 1, mark_read_failed: 0,
    })
    const read = { action: 'read', accountId: account!.id, mailbox: 'INBOX', validity: '1', uid: 1 }
    expect(sends.pop()).toEqual(read)
    expect(sends.pop()).toEqual({ action: 'seen', accountId: account!.id, mailbox: 'INBOX', validity: '1', uid: 1, seen: true })
    expect(sends.pop()).toMatchObject({ action: 'messages', mailbox: 'INBOX', query: '合成', subjectOnly: true, limit: 1 })
    const reopened = createDesktopMailService(directory, encryption, transport)
    expect((await reopened.listAccounts())[0]?.version).toBe(account?.version)
    await expect(reopened.handlers[DESKTOP_CHANNELS.mail](read)).resolves.toMatchObject({ text: '合成正文' })
    expect(sends).toHaveLength(0)
    await expect(reopened.listForAgent({ account: account!.id, limit: 1 })).resolves.toMatchObject({
      items: [{ snippet: '合成正文' }],
    })
    expect(sends.splice(0).map(command => (command as { action: string }).action)).toEqual(['messages', 'seen'])
    const request = {
      accountId: account!.id,
      accountVersion: account!.version,
      attachmentDigest: desktopMailAttachmentDigest([]),
      attemptId: '00000000-0000-4000-8000-000000000001',
      fileRefs: [],
      draft: { to: ['recipient@example.test'], subject: '合成邮件', text: '不连接真实 SMTP' },
    }
    await expect(service.sendForAgent({ ...request, accountVersion: '0'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' })
    expect(sends).toHaveLength(0)
    await expect(service.sendForAgent({ ...request, saveDraft: true })).resolves.toMatchObject({ ok: true })
    expect(sends.pop()).toMatchObject({ action: 'draft', accountId: account!.id })
    await expect(service.sendForAgent(request)).resolves.toMatchObject({ partial: false })
    await expect(service.sendForAgent(request)).rejects.toMatchObject({ code: 'conflict' })
    expect(sends).toHaveLength(1)
  })

  it('重新读取引用附件并在确认后文件内容变化时拒绝发送', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-agent-mail-'))
    directories.push(directory)
    const sends: unknown[] = []
    let contents = Buffer.from('合成文件 v1')
    const transport: MailTransport = {
      async verify() {},
      async execute(_account, command) { sends.push(command); return { partial: false } },
    }
    const encryption = {
      async isAsyncEncryptionAvailable() { return true },
      async encryptStringAsync(value: string) { return Buffer.from(value) },
      async decryptStringAsync(value: Buffer) { return { result: value.toString('utf8'), shouldReEncrypt: false } },
    }
    const service = createDesktopMailService(directory, encryption, transport,
      async references => references.map(() => ({ filename: '资料.txt', mimeType: 'text/plain', content: contents })))
    const connect = service.handlers[DESKTOP_CHANNELS.mail]
    await connect({ action: 'connect', account: {
      email: 'sender@example.test', username: 'sender', password: 'synthetic-secret',
      imapHost: 'imap.example.test', smtpHost: 'smtp.example.test', smtpPort: 465,
    } })
    const [account] = await service.listAccounts()
    const refs = ['drop-synthetic-ref']
    const manifest = await service.inspectAgentAttachments({ references: refs }) as {
      digest: string; items: { filename: string; size: number }[]
    }
    expect(manifest.items).toEqual([{ filename: '资料.txt', mimeType: 'text/plain', size: Buffer.byteLength(contents) }])
    const templateBrand = { theme: 'dark', palette: 'neutral' }
    const rendered = renderSmtpDraftMessage({ subject: '附件邮件', title: '模板邮件', body: '核对附件', ...templateBrand })
    const request = {
      accountId: account!.id, accountVersion: account!.version, attachmentDigest: manifest.digest,
      attemptId: '00000000-0000-4000-8000-000000000002', fileRefs: refs,
      draft: { to: ['recipient@example.test'], subject: '附件邮件', text: '核对附件',
        html: rendered.html, templateBrand },
    }
    const frame = { v: 2, event: 'host_request', requestId: 1, method: 'agent.email.send', params: request }
    expect(Buffer.byteLength(JSON.stringify(frame)) + 1).toBeLessThan(MAX_FRAME)
    await expect(service.sendForAgent(request)).resolves.toMatchObject({ partial: false })
    expect(sends[0]).toMatchObject({ action: 'send', draft: { html: rendered.html, attachments: [
      { filename: '资料.txt', mimeType: 'text/plain' },
      ...rendered.images.map(({ filename, cid, base64 }) => ({ filename, cid, content: Buffer.from(base64, 'base64') })),
    ] } })
    contents = Buffer.from('合成文件 v2')
    await expect(service.sendForAgent({ ...request, attemptId: '00000000-0000-4000-8000-000000000003' }))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(sends).toHaveLength(1)
  })

  it('发件账户在附件读取期间发生变化时不认领发送尝试', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-agent-mail-'))
    directories.push(directory)
    const sends: unknown[] = []
    const transport: MailTransport = {
      async verify() {},
      async execute(_account, command) { sends.push(command); return { partial: false } },
    }
    const encryption = {
      async isAsyncEncryptionAvailable() { return true },
      async encryptStringAsync(value: string) { return Buffer.from(value) },
      async decryptStringAsync(value: Buffer) { return { result: value.toString('utf8'), shouldReEncrypt: false } },
    }
    const file = { filename: '资料.txt', mimeType: 'text/plain', content: Buffer.from('合成附件') }
    let accountId = ''
    let service!: ReturnType<typeof createDesktopMailService>
    service = createDesktopMailService(directory, encryption, transport, async () => {
      await service.handlers[DESKTOP_CHANNELS.mail]!({ action: 'connect', accountId, account: {
        email: 'sender@example.test', username: 'sender', password: 'changed-secret',
        imapHost: 'imap.example.test', smtpHost: 'smtp.example.test', smtpPort: 465,
      } })
      return [file]
    })
    const connect = service.handlers[DESKTOP_CHANNELS.mail]
    await connect({ action: 'connect', account: {
      email: 'sender@example.test', username: 'sender', password: 'synthetic-secret',
      imapHost: 'imap.example.test', smtpHost: 'smtp.example.test', smtpPort: 465,
    } })
    const [account] = await service.listAccounts()
    accountId = account!.id
    await expect(service.sendForAgent({
      accountId, accountVersion: account!.version, attachmentDigest: desktopMailAttachmentDigest([file]),
      attemptId: '00000000-0000-4000-8000-000000000004', fileRefs: ['path-synthetic-ref'],
      draft: { to: ['recipient@example.test'], subject: '并发修改', text: '正文' },
    })).rejects.toMatchObject({ code: 'conflict' })
    expect(sends).toHaveLength(0)
  })
})
