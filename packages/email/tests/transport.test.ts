import { beforeEach, expect, it, vi } from 'vitest'
import type { MailAccount } from '../src/contracts.js'

const mocks = vi.hoisted(() => ({
  imapOptions: vi.fn(), smtpOptions: vi.fn(), smtpVerify: vi.fn(), smtpSend: vi.fn(),
  imap: {
    capabilities: new Map(), mailbox: { uidValidity: 7n, exists: 1 },
    usable: false, noop: vi.fn(), search: vi.fn(), fetchAll: vi.fn(),
    on: vi.fn(), once: vi.fn(), status: vi.fn(), mailboxOpen: vi.fn(), idle: vi.fn(), connect: vi.fn(), close: vi.fn(), list: vi.fn(),
    getMailboxLock: vi.fn(), messageMove: vi.fn(), fetchOne: vi.fn(),
  },
  pinned: vi.fn(), sanitize: vi.fn(),
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

import { createMailTransport } from '../src/transport.js'

const makeTransport = () => createMailTransport({ resolveAddress: mocks.pinned, sanitizeHtml: mocks.sanitize })

const account: MailAccount = {
  id: 'bc796da9-5864-4a38-9db7-d02ebdb985dd', email: 'test@example.com', username: 'test@example.com',
  imapHost: 'imap.example.com', smtpHost: 'smtp.example.com', smtpPort: 587, password: '合成授权码',
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.pinned.mockResolvedValue('192.0.2.1')
  mocks.sanitize.mockImplementation(value => value)
  mocks.imap.getMailboxLock.mockResolvedValue({ release: vi.fn() })
  mocks.imap.list.mockResolvedValue([{ path: 'Trash', name: 'Trash', specialUse: '\\Trash', flags: new Set() }])
  mocks.imap.capabilities.clear()
  mocks.imap.usable = false
  mocks.imap.mailbox.exists = 1
})

it('首次打开邮箱只取尾部一页，连续读取复用连接，UID 翻页保持不变', async () => {
  const transport = makeTransport()
  const command = { action: 'messages', accountId: account.id, mailbox: 'INBOX', limit: 2 } as const
  mocks.imap.usable = true
  mocks.imap.mailbox.exists = 10
  mocks.imap.fetchAll.mockResolvedValueOnce([{ uid: 70 }, { uid: 90 }, { uid: 100 }])
  await expect(transport.execute(account, command)).resolves.toMatchObject({
    items: [{ uid: 100 }, { uid: 90 }], validity: '7', next: 90,
  })
  expect(mocks.imap.fetchAll).toHaveBeenCalledWith('8:10', expect.any(Object))
  expect(mocks.imap.search).not.toHaveBeenCalled()
  mocks.imap.search.mockResolvedValueOnce([50, 60, 70])
  mocks.imap.fetchAll.mockResolvedValueOnce([{ uid: 60 }, { uid: 70 }])
  await expect(transport.execute(account, { ...command, before: 90 })).resolves.toMatchObject({
    items: [{ uid: 70 }, { uid: 60 }], next: 60,
  })
  expect(mocks.imap.search).toHaveBeenCalledWith({ uid: '1:89' }, { uid: true })
  expect(mocks.imap.connect).toHaveBeenCalledOnce()
  expect(mocks.imap.noop).toHaveBeenCalledOnce()
  transport.forgetImap?.(account.id)
  expect(mocks.imap.close).toHaveBeenCalledOnce()
})

it('连接验证只认证，固定经过检查的地址并校验原服务名的证书', async () => {
  await makeTransport().verify(account)
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
  const transport = makeTransport()
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
  await expect(makeTransport().execute(account, {
    action: 'send', accountId: account.id, attemptId: account.id,
    draft: { to: ['recipient@example.com'], subject: '合成主题', text: '合成正文' },
  })).rejects.toMatchObject({ status: 502, message: '发送结果未确认，请核对已发送邮件后再决定是否重试' })
  expect(mocks.smtpSend).toHaveBeenCalledOnce()
})

it('SMTP 发送清理后的 HTML 和内存附件，并禁用文件与 URL 读取', async () => {
  mocks.smtpSend.mockResolvedValueOnce({ messageId: '<synthetic@example.test>', rejected: [] })
  mocks.sanitize.mockReturnValueOnce('<p style="color:#123">安全内容</p>')
  await makeTransport().execute(account, {
    action: 'send', accountId: account.id, attemptId: account.id,
    draft: {
      to: ['recipient@example.com'], subject: '安全 HTML', text: '纯文本正文',
      html: '<p style="color:#123">安全内容</p><script>禁止脚本</script><img src="https://example.test/x.png">',
      attachments: [{ filename: '资料.txt', mimeType: 'text/plain', content: Buffer.from('合成附件') },
        { filename: 'logo.png', mimeType: 'image/png', content: Buffer.from('合成图片'), cid: 'gugu-logo-mark' }],
    },
  })
  expect(mocks.sanitize).toHaveBeenCalledWith(expect.stringContaining('<script>'))
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

it('读取 MIME 邮件时返回纯文本和经过策略清理的富文本', async () => {
  const source = Buffer.from([
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="test-mail"',
    '', '--test-mail', 'Content-Type: text/plain; charset=utf-8', '', '普通正文',
    '--test-mail', 'Content-Type: text/html; charset=utf-8', '',
    '<p>富文本 <strong>正文</strong></p><img src="https://example.test/tracking.png">',
    '--test-mail--', '',
  ].join('\r\n'))
  mocks.imap.fetchOne.mockResolvedValueOnce({ uid: 3, size: source.length, source })
  mocks.sanitize.mockReturnValueOnce('<p>富文本 <strong>正文</strong></p>')
  await expect(makeTransport().execute(account, {
    action: 'read', accountId: account.id, mailbox: 'INBOX', uid: 3, validity: '7',
  })).resolves.toMatchObject({ text: expect.stringContaining('普通正文'), html: '<p>富文本 <strong>正文</strong></p>' })
  expect(mocks.sanitize).toHaveBeenCalledWith(expect.stringContaining('tracking.png'), true)
})

it('只在服务器搜索未读邮件，并通过 UID 继续加载更早的结果', async () => {
  mocks.imap.mailbox.exists = 100
  const transport = makeTransport()
  const command = { action: 'messages', accountId: account.id, mailbox: 'INBOX', unreadOnly: true, limit: 1 } as const
  mocks.imap.search.mockResolvedValueOnce([3, 8]).mockResolvedValueOnce([3])
  mocks.imap.fetchAll.mockResolvedValueOnce([{ uid: 8 }]).mockResolvedValueOnce([{ uid: 3 }])
  await expect(transport.execute(account, command)).resolves.toMatchObject({ items: [{ uid: 8 }], next: 8 })
  await expect(transport.execute(account, { ...command, before: 8 })).resolves.toMatchObject({ items: [{ uid: 3 }], next: null })
  expect(mocks.imap.search).toHaveBeenNthCalledWith(1, { uid: '1:*', seen: false }, { uid: true })
  expect(mocks.imap.search).toHaveBeenNthCalledWith(2, { uid: '1:7', seen: false }, { uid: true })
})

const watchId = '5eefb90a-6f28-4376-9b6f-ee2fe126ee42'
const watchCommand = { action: 'watchInbox', accountId: account.id, watchId } as const

it('收件箱变更结束 IDLE 请求并释放连接', async () => {
  mocks.imap.capabilities.set('IDLE', true)
  mocks.imap.status.mockResolvedValue({ uidValidity: 7n, uidNext: 2, messages: 1, unseen: 0 })
  const cursor = '7:2:1:0'
  const transport = makeTransport()
  await expect(transport.execute(account, watchCommand)).resolves.toEqual({ cursor, changed: true, idle: true, unreadCount: 0 })
  mocks.imap.idle.mockImplementation(async () => {
    const listener = mocks.imap.once.mock.calls.find(([event]) => event === 'exists')?.[1]
    listener?.()
    return true
  })
  await expect(transport.execute(account, { ...watchCommand, cursor })).resolves.toEqual({ cursor, changed: true, idle: true, unreadCount: 0 })
  expect(mocks.imap.mailboxOpen).toHaveBeenCalledWith('INBOX', { readOnly: true })
  expect(mocks.imap.close).toHaveBeenCalledTimes(2)
})

it('不支持 IDLE 的账号返回状态供低频补拉', async () => {
  mocks.imap.status.mockResolvedValue({ uidValidity: 7n, uidNext: 2, messages: 100, unseen: 37 })
  await expect(makeTransport().execute(account, { ...watchCommand, cursor: '7:2:100:37' }))
    .resolves.toEqual({ cursor: '7:2:100:37', changed: false, idle: false, unreadCount: 37 })
  expect(mocks.imap.idle).not.toHaveBeenCalled()
})

it('离开邮箱时只取消匹配的监听并释放连接', async () => {
  mocks.imap.capabilities.set('IDLE', true)
  mocks.imap.status.mockResolvedValue({ uidValidity: 7n, uidNext: 2, messages: 1, unseen: 0 })
  mocks.imap.idle.mockReturnValue(new Promise(() => {}))
  mocks.imap.close.mockImplementation(() => {
    const listener = mocks.imap.once.mock.calls.find(([event]) => event === 'close')?.[1]
    listener?.()
  })
  const transport = makeTransport()
  const result = transport.execute(account, { ...watchCommand, cursor: '7:2:1:0' })
  const ended = expect(result).rejects.toMatchObject({ status: 502 })
  try {
    await vi.waitFor(() => expect(mocks.imap.idle).toHaveBeenCalled())
    await transport.execute(account, { ...watchCommand, action: 'stopInboxWatch', watchId: '39de00e5-7793-4441-96a1-f87b07c04727' })
    expect(mocks.imap.close).not.toHaveBeenCalled()
    await transport.execute(account, { ...watchCommand, action: 'stopInboxWatch' })
    await ended
  } finally { mocks.imap.close.mockReset() }
})
