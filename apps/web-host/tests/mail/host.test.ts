import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerMailRoutes } from '../../src/modules/mail/routes.js'
import { createWebMailStore } from '../../src/modules/mail/store.js'
import { signedUserToken } from '../helpers/auth.js'

test('Web 邮箱命令要求登录，账户按用户归属读取且凭据加密落盘', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-mail-test-'))
  const secret = 'synthetic-auth-secret-only-for-tests'
  const owner = '00000000-0000-4000-8000-000000000001'
  const other = '00000000-0000-4000-8000-000000000002'
  const id = '00000000-0000-4000-8000-000000000003'
  const password = '仅测试的邮箱授权码'
  const app = Fastify()
  const env = { CREDENTIALS_MASTER_KEY: 'synthetic-mail-encryption-key', CREDENTIALS_MASTER_KEY_FILE: join(directory, 'master-key') }
  try {
    const store = createWebMailStore(env)
    await store.put(owner, { id, password, email: 'test@example.com', username: 'test@example.com',
      imapHost: 'imap.example.com', smtpHost: 'smtp.example.com', smtpPort: 465 })
    const savedDir = join(directory, 'mail-accounts')
    const [ownerDirectory] = await readdir(savedDir)
    const record = await readFile(join(savedDir, ownerDirectory!, id + '.json'), 'utf8')
    assert.ok(!record.includes(password))
    assert.equal((await store.get(owner, id))?.password, password)
    registerMailRoutes(app, { secret, lookupUser: async userId => ({
      id: userId, username: '测试用户', isActive: true, accountStatus: 'active', securityVersion: 1,
      displayName: null, email: null, avatarUrl: null, createdAt: null, timezone: null,
      emailSubscribed: false, imChannels: [],
    }) }, env)
    const command = (payload: object, user?: string) => app.inject({
      method: 'POST', url: '/api/v1/mail/command', payload,
      headers: user ? { authorization: 'Bearer ' + signedUserToken(secret, user) } : {},
    })
    assert.equal((await command({ action: 'accounts' })).statusCode, 401)
    assert.equal((await command({ action: 'folders', accountId: id }, other)).statusCode, 404)
    const response = await command({ action: 'accounts' }, owner)
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.deepEqual(response.json().map(({ id, email }: { id: string; email: string }) => ({ id, email })), [{ id, email: 'test@example.com' }])
    assert.ok(!response.body.includes(password))
  } finally {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})
