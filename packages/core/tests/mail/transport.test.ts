import { beforeEach, expect, it, vi } from 'vitest'
import type { MailAccount } from '../../src/mail/contracts.js'

const mocks = vi.hoisted(() => ({
  imapOptions: vi.fn(), smtpOptions: vi.fn(), smtpVerify: vi.fn(), smtpSend: vi.fn(),
  imap: {
    capabilities: new Map(), mailbox: { uidValidity: 7n, exists: 1 },
    on: vi.fn(), connect: vi.fn(), close: vi.fn(), list: vi.fn(),
    getMailboxLock: vi.fn(), messageMove: vi.fn(), fetchOne: vi.fn(),
  },
  pinned: vi.fn(),
}))
vi.mock('imapflow', () => ({
  ImapFlow: class { constructor(options: unknown) { mocks.imapOptions(options); return mocks.imap } },
}))
vi.mock('nodemailer', () => ({
  default: { createTransport(options: unknown) {
    mocks.smtpOptions(options)
    return { verify: mocks.smtpVerify, sendMail: mocks.smtpSend, close: vi.fn() }
  } },
}))
vi.mock('../../src/agent/providers/transport/network.js', () => ({ resolvePinnedTarget: mocks.pinned }))

import { createMailTransport } from '../../src/mail/transport.js'

const account: MailAccount = {
  id: 'bc796da9-5864-4a38-9db7-d02ebdb985dd', email: 'test@example.com', username: 'test@example.com',
  imapHost: 'imap.example.com', smtpHost: 'smtp.example.com', smtpPort: 587, password: '合成授权码',
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.pinned.mockResolvedValue({ target: { address: '192.0.2.1' } })
  mocks.imap.getMailboxLock.mockResolvedValue({ release: vi.fn() })
  mocks.imap.list.mockResolvedValue([{ path: 'Trash', name: 'Trash', specialUse: '\\Trash', flags: new Set() }])
  mocks.imap.capabilities.clear()
})

it('连接验证只认证，固定经过检查的地址并校验原服务名的证书', async () => {
  await createMailTransport().verify(account)
  expect(mocks.imapOptions).toHaveBeenCalledWith(expect.objectContaining({
    host: '192.0.2.1', servername: account.imapHost, secure: true, logger: false,
  }))
  expect(mocks.smtpOptions).toHaveBeenCalledWith(expect.objectContaining({
    host: '192.0.2.1', port: 587, requireTLS: true, tls: { servername: account.smtpHost },
  }))
  expect(mocks.smtpVerify).toHaveBeenCalledOnce()
  expect(mocks.smtpSend).not.toHaveBeenCalled()
})

it('UIDVALIDITY 过期或缺少定向移动能力时不会修改邮箱', async () => {
  const transport = createMailTransport()
  const command = { action: 'move', accountId: account.id, mailbox: 'INBOX', uid: 3, validity: '7', target: 'trash' } as const
  await expect(transport.execute(account, command)).rejects.toMatchObject({ status: 409 })
  mocks.imap.capabilities.set('MOVE', true)
  await expect(transport.execute(account, { ...command, validity: '6' })).rejects.toMatchObject({ status: 409 })
  expect(mocks.imap.messageMove).not.toHaveBeenCalled()
  mocks.imap.messageMove.mockResolvedValueOnce(true)
  await expect(transport.execute(account, command)).resolves.toEqual({ ok: true })
  expect(mocks.imap.messageMove).toHaveBeenCalledWith(3, 'Trash', { uid: true })
})

it('SMTP 返回不明错误时只提交一次并返回不含服务商原文的指引', async () => {
  mocks.smtpSend.mockRejectedValueOnce(new Error('合成敏感服务商报文'))
  await expect(createMailTransport().execute(account, {
    action: 'send', accountId: account.id, attemptId: account.id,
    draft: { to: ['recipient@example.com'], subject: '合成主题', text: '合成正文' },
  })).rejects.toMatchObject({ status: 502, message: '发送结果未确认，请核对已发送邮件后再决定是否重试' })
  expect(mocks.smtpSend).toHaveBeenCalledOnce()
})

it('SMTP 发送清理后的 HTML 和内存附件，并禁用文件与 URL 读取', async () => {
  mocks.smtpSend.mockResolvedValueOnce({ messageId: '<synthetic@example.test>', rejected: [] })
  await createMailTransport().execute(account, {
    action: 'send', accountId: account.id, attemptId: account.id,
    draft: {
      to: ['recipient@example.com'], subject: '安全 HTML', text: '纯文本正文',
      html: '<p style="color:#123">安全内容</p><script>禁止脚本</script><img src="https://example.test/x.png">',
      attachments: [{ filename: '资料.txt', mimeType: 'text/plain', content: Buffer.from('合成附件') },
        { filename: 'logo.png', mimeType: 'image/png', content: Buffer.from('合成图片'), cid: 'gugu-logo-mark' }],
    },
  })
  const options = mocks.smtpSend.mock.calls[0]?.[0] as Record<string, unknown>
  expect(options.html).toContain('<p style="color:#123">安全内容</p>')
  expect(options.html).not.toMatch(/script|example\.test\/x\.png/u)
  expect(options.disableFileAccess).toBe(true)
  expect(options.disableUrlAccess).toBe(true)
  expect(options.attachments).toMatchObject([
    { filename: '资料.txt', contentType: 'text/plain' },
    { filename: 'logo.png', contentType: 'image/png', cid: 'gugu-logo-mark' },
  ])
  expect((options.attachments as { content: Buffer }[])[0]?.content.toString()).toBe('合成附件')
})
