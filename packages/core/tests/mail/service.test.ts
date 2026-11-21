import { describe, expect, it, vi } from 'vitest'
import { createMailService, type MailStore } from '../../src/mail/service.js'
import type { MailAccount } from '../../src/mail/contracts.js'

const fixture = {
  email: 'test@example.com', username: 'test@example.com', password: '合成授权码',
  imapHost: 'imap.example.com', smtpHost: 'smtp.example.com', smtpPort: 465,
} as const

function setup() {
  const rows = new Map<string, MailAccount>()
  const attempts = new Set<string>()
  const store: MailStore = {
    list: async owner => [...rows.entries()].filter(([key]) => key.startsWith(owner + ':'))
      .map(([, { password: _password, ...row }]) => row),
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
