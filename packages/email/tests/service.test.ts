import { describe, expect, it, vi } from 'vitest'
import { createMailService, type MailStore } from '../src/service.js'
import { summarizeMailAccount, type MailAccount } from '../src/contracts.js'

const fixture = {
  email: 'test@example.com', username: 'test@example.com', password: '合成授权码',
  imapHost: 'imap.example.com', smtpHost: 'smtp.example.com', smtpPort: 465,
} as const

function setup() {
  const rows = new Map<string, MailAccount>()
  const attempts = new Set<string>()
  const store: MailStore = {
    list: async owner => [...rows.entries()].filter(([key]) => key.startsWith(owner + ':'))
      .map(([, account]) => summarizeMailAccount(account)),
    get: async (owner, id) => rows.get(owner + ':' + id) ?? null,
    put: async (owner, account) => { rows.set(owner + ':' + account.id, account) },
    remove: async (owner, id) => { rows.delete(owner + ':' + id) },
    claimSend: async (owner, id, attempt) => {
      const key = [owner, id, attempt].join(':')
      if (attempts.has(key)) return false
      attempts.add(key)
      return true
    },
  }
  const transport = { verify: vi.fn(async () => {}), execute: vi.fn(async () => ({})) }
  const execute = createMailService(store, transport)
  async function connect() { return await execute('甲', { action: 'connect', account: fixture }) as { id: string } }
  return { execute, connect, transport }
}

describe('个人邮箱命令', () => {
  it('重连留空时复用当前用户保存的凭据，验证失败不覆盖原凭据', async () => {
    const { execute, transport } = setup()
    const original = { ...fixture, smtpUsername: 'smtp@example.com', smtpPassword: '合成发件授权码' }
    const { id } = await execute('甲', { action: 'connect', account: original }) as { id: string }
    const reconnect = { ...original, password: '', smtpPassword: undefined }
    const result = await execute('甲', { action: 'connect', accountId: id, account: reconnect })
    expect(result).not.toHaveProperty('password')
    expect(result).not.toHaveProperty('smtpPassword')
    expect(transport.verify).toHaveBeenLastCalledWith(expect.objectContaining(original))
    transport.verify.mockRejectedValueOnce(new Error('验证失败'))
    await expect(execute('甲', { action: 'connect', accountId: id, account: { ...original, password: '新授权码' } })).rejects.toThrow()
    await execute('甲', { action: 'connect', accountId: id, account: reconnect })
    expect(transport.verify).toHaveBeenLastCalledWith(expect.objectContaining(original))
    await expect(execute('乙', { action: 'connect', accountId: id, account: reconnect })).rejects.toMatchObject({ status: 404 })
    await expect(execute('甲', { action: 'connect', account: reconnect })).rejects.toMatchObject({ status: 400 })
    await expect(execute('甲', { action: 'connect', accountId: id, account: { ...reconnect, imapHost: 'other.example.com' } })).rejects.toMatchObject({ status: 400 })
  })
  it('聚合收件箱按日期合并账户，保留消息定位和各账户分页，仅查询当前用户', async () => {
    const { execute, connect, transport } = setup()
    const first = await connect()
    const second = await connect()
    await execute('乙', { action: 'connect', account: fixture })
    transport.execute.mockResolvedValueOnce({ validity: '10', items: [{ uid: 2, date: '2026-01-01' }], next: 2 })
    transport.execute.mockResolvedValueOnce({ validity: '11', items: [{ uid: 2, date: '2026-01-02' }], next: null })
    await expect(execute('甲', { action: 'inbox', query: '报价', unreadOnly: true })).resolves.toEqual({
      items: [
        { accountId: second.id, mailbox: 'INBOX', validity: '11', uid: 2, date: '2026-01-02' },
        { accountId: first.id, mailbox: 'INBOX', validity: '10', uid: 2, date: '2026-01-01' },
      ], unavailableAccountIds: [], next: { [first.id]: 2 },
    })
    expect(transport.execute).toHaveBeenCalledTimes(2)
    expect(transport.execute.mock.calls.map(([, command]) => command)).toEqual([
      expect.objectContaining({ unreadOnly: true }), expect.objectContaining({ unreadOnly: true }),
    ])
    transport.execute.mockRejectedValueOnce(new Error('合成连接失败'))
    await expect(execute('甲', { action: 'inbox', before: { [first.id]: 2 } }))
      .resolves.toEqual({ items: [], unavailableAccountIds: [first.id], next: {} })
    expect(transport.execute).toHaveBeenLastCalledWith(expect.objectContaining({ id: first.id }),
      expect.objectContaining({ action: 'messages', before: 2 }))
  })

  it('仅接收账号会清除 SMTP 凭据，并拒绝发信', async () => {
    const { execute, transport } = setup()
    const saved = await execute('甲', {
      action: 'connect', account: { ...fixture, receiveOnly: true, smtpPassword: '合成 SMTP 密码' },
    }) as { id: string }
    expect(saved).toMatchObject({ receiveOnly: true, smtpHost: '' })
    expect(saved).not.toHaveProperty('smtpPassword')
    expect(transport.verify).toHaveBeenCalledWith(expect.not.objectContaining({ smtpPassword: expect.anything() }))
    await expect(execute('甲', {
      action: 'send', accountId: saved.id, attemptId: 'bc796da9-5864-4a38-9db7-d02ebdb985dd',
      draft: { to: ['recipient@example.com'], subject: '合成邮件', text: '' },
    })).rejects.toMatchObject({ status: 409 })
    expect(transport.execute).not.toHaveBeenCalled()
  })

  it('验证失败不保存账户，返回列表和连接结果均不包含凭据', async () => {
    const { execute, connect, transport } = setup()
    transport.verify.mockRejectedValueOnce(new Error('合成连接错误'))
    await expect(connect()).rejects.toThrow()
    expect(await execute('甲', { action: 'accounts' })).toEqual([])
    expect(await connect()).not.toHaveProperty('password')
    expect(await execute('甲', { action: 'accounts' })).toEqual([expect.not.objectContaining({ password: fixture.password })])
  })

  it('邮箱 ID 不能跨用户读取、重连或断开', async () => {
    const { execute, connect, transport } = setup()
    const { id } = await connect()
    await expect(execute('乙', { action: 'connect', account: fixture, accountId: id })).rejects.toMatchObject({ status: 404 })
    await expect(execute('乙', { action: 'disconnect', accountId: id })).rejects.toMatchObject({ status: 404 })
    await expect(execute('乙', { action: 'folders', accountId: id })).rejects.toMatchObject({ status: 404 })
    expect(transport.execute).not.toHaveBeenCalled()
    await expect(execute('甲', { action: 'folders', accountId: id })).resolves.toEqual({})
  })

  it('发信回执丢失后重复请求不会再次提交 SMTP', async () => {
    const { execute, connect, transport } = setup()
    const { id } = await connect()
    transport.execute.mockRejectedValueOnce(new Error('合成的未知投递结果'))
    const command = {
      action: 'send', accountId: id, attemptId: 'bc796da9-5864-4a38-9db7-d02ebdb985dd',
      draft: { to: ['recipient@example.com'], text: '合成邮件', subject: '测试邮件' },
    }
    await expect(execute('甲', command)).rejects.toThrow()
    await expect(execute('甲', command)).rejects.toMatchObject({ status: 409 })
    expect(transport.execute).toHaveBeenCalledTimes(1)
  })
})
