import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerMailRoutes } from '../../src/modules/mail/routes.js'
import { createCachedMailService } from '@gugu/email/cached-service'
import { createMailReadCache } from '@gugu/email/read-cache'
import { createWebMailStore, createWebMailCacheStore } from '../../src/modules/mail/store.js'
import { signedUserToken } from '../helpers/auth.js'

test('Web 邮箱命令要求登录，账户按用户归属读取且凭据加密落盘', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-mail-test-'))
  const secret = 'synthetic-auth-secret-only-for-tests'
  const owner = '00000000-0000-4000-8000-000000000001'
  const other = '00000000-0000-4000-8000-000000000002'
  const id = '00000000-0000-4000-8000-000000000003'
  const password = '仅测试的邮箱授权码'
  const smtpPassword = '仅测试的独立发件授权码'
  const app = Fastify()
  const env = { CREDENTIALS_MASTER_KEY: 'synthetic-mail-encryption-key', CREDENTIALS_MASTER_KEY_FILE: join(directory, 'master-key') }
  try {
    const store = createWebMailStore(env)
    await store.put(owner, { id, password, smtpPassword, email: 'test@example.com', username: 'test@example.com',
      imapHost: 'imap.example.com', smtpHost: 'smtp.example.com', smtpPort: 465 })
    const savedDir = join(directory, 'mail-accounts')
    const [ownerDirectory] = await readdir(savedDir)
    const record = await readFile(join(savedDir, ownerDirectory!, id + '.json'), 'utf8')
    assert.ok(!record.includes(password))
    assert.ok(!record.includes(smtpPassword))
    assert.equal((await store.get(owner, id))?.password, password)
    registerMailRoutes(app, { secret, lookupUser: async userId => ({
      id: userId, username: '测试用户', isActive: true, accountStatus: 'active', securityVersion: 1,
      displayName: null, email: 'user@example.test', avatarUrl: null, createdAt: '2026-01-01T00:00:00Z', timezone: null,
      emailSubscribed: false, imChannels: [],
    }) }, env)
    const command = (payload: object, user?: string) => app.inject({
      method: 'POST', url: '/api/v1/mail/command', payload,
      headers: user ? { authorization: 'Bearer ' + signedUserToken(secret, user) } : {},
    })
    assert.equal((await command({ action: 'accounts' })).statusCode, 401)
    assert.equal((await command({ action: 'folders', accountId: id }, other)).statusCode, 404)
    assert.deepEqual((await command({ action: 'inbox', before: { [id]: 4 } }, other)).json(),
      { items: [], unavailableAccountIds: [], next: {} })
    const response = await command({ action: 'accounts' }, owner)
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.deepEqual(response.json().map(({ id, email }: { id: string; email: string }) => ({ id, email })), [{ id, email: 'test@example.com' }])
    assert.ok(!response.body.includes(password))
    assert.ok(!response.body.includes(smtpPassword))
  } finally {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('咕咕缓存的正文可由 Web 邮箱重开读取，相同邮箱身份在不同 owner 间隔离', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-web-mail-cache-'))
  const env = { CREDENTIALS_MASTER_KEY: 'synthetic-mail-encryption-key', CREDENTIALS_MASTER_KEY_FILE: join(directory, 'master-key') }
  const owner = 'owner-a', other = 'owner-b'
  const accountId = '00000000-0000-4000-8000-000000000003'
  const account = { id: accountId, password: 'synthetic-secret', email: 'example@example.test',
    username: 'sample', imapHost: 'imap.example.test', smtpHost: 'smtp.example.test', smtpPort: 465 as const }
  const read = { action: 'read', accountId, mailbox: 'INBOX', uid: 1, validity: '7' }
  const summary = { uid: 1, subject: '合成标题', from: 'sender@example.test', replyTo: '', to: [], date: null, seen: true }
  let loads = 0
  try {
    const store = createWebMailStore(env)
    await store.put(owner, account)
    await store.put(other, account)
    const service = () => createCachedMailService(store, {
      async verify() {},
      async execute(_account, command) {
        if (command.action === 'messages') return { items: [summary], validity: '7', next: null }
        return { ...summary, text: `合成正文 ${++loads}`, attachments: [] }
      },
    }, createMailReadCache(createWebMailCacheStore(env)))
    assert.equal((await service().listForAgent(owner, { account: accountId })).items[0]?.snippet, '合成正文 1')
    assert.match(JSON.stringify(await service().execute(owner, read)), /合成正文 1/u)
    assert.equal(loads, 1)
    assert.match(JSON.stringify(await service().execute(other, read)), /合成正文 2/u)
    assert.equal(loads, 2)
    const files = await readdir(join(directory, 'mail-read-cache'))
    for (const file of files) assert.ok(!(await readFile(join(directory, 'mail-read-cache', file), 'utf8')).includes('合成正文'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
