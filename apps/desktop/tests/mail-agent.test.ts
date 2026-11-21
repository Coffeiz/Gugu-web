import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { MailTransport } from '@gugu/core/mail/service'
import { afterEach, describe, expect, it } from 'vitest'
import { desktopMailAttachmentDigest } from '../src/main/mail/attachments.js'
import { createDesktopMailService } from '../src/main/mail/index.js'

describe('桌面 Agent 邮件宿主端口', () => {
  const directories: string[] = []
  afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

  it('只返回脱敏账户信息，绑定账户版本并按尝试 ID 阻止重复发送', async () => {
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
    const service = createDesktopMailService(directory, encryption, transport)
    const connect = service.handlers[DESKTOP_CHANNELS.mail]
    await connect({ action: 'connect', account: {
      email: 'sender@example.test', username: 'sender', password: 'synthetic-secret',
      imapHost: 'imap.example.test', smtpHost: 'smtp.example.test', smtpPort: 465,
    } })
    const [account] = await service.listAccounts()
    expect(account).toMatchObject({ email: 'sender@example.test', version: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(account).not.toHaveProperty('password')
    const request = {
      accountId: account!.id,
      accountVersion: account!.version,
      attachmentDigest: desktopMailAttachmentDigest([]),
      attemptId: '00000000-0000-4000-8000-000000000001',
      fileRefs: [],
      draft: { to: ['recipient@example.test'], subject: '合成邮件', text: '不连接真实 SMTP', inlineAttachments: [] },
    }
    await expect(service.sendForAgent({ ...request, accountVersion: '0'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' })
    expect(sends).toHaveLength(0)
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
    const request = {
      accountId: account!.id, accountVersion: account!.version, attachmentDigest: manifest.digest,
      attemptId: '00000000-0000-4000-8000-000000000002', fileRefs: refs,
      draft: { to: ['recipient@example.test'], subject: '附件邮件', text: '核对附件',
        html: '<p>核对附件</p>', inlineAttachments: [{ base64: Buffer.from('synthetic-logo').toString('base64'),
          cid: 'gugu-logo-mark', filename: 'logo-mark.png', mimeType: 'image/png' }] },
    }
    await expect(service.sendForAgent(request)).resolves.toMatchObject({ partial: false })
    expect(sends[0]).toMatchObject({ action: 'send', draft: { html: '<p>核对附件</p>', attachments: [
      { filename: '资料.txt', mimeType: 'text/plain' }, { filename: 'logo-mark.png', cid: 'gugu-logo-mark' },
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
      draft: { to: ['recipient@example.test'], subject: '并发修改', text: '正文', inlineAttachments: [] },
    })).rejects.toMatchObject({ code: 'conflict' })
    expect(sends).toHaveLength(0)
  })
})
