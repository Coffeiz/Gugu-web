import assert from 'node:assert/strict'
import { createECDH, randomUUID, randomBytes } from 'node:crypto'
import test from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { Pool } from 'pg'
import { migratePostgres } from '@gugu/database/postgres'
import { generateVAPIDKeys } from 'web-push'
import { createApp } from '../../src/app.js'
import { createWebPush } from '../../src/modules/notifications/push.js'
import { createPostgresScheduledTaskTestDelivery } from '../../src/modules/scheduled-tasks/delivery/results.js'
import { signedUserToken } from '../helpers/auth.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('Web 提醒只进入同账号订阅，失效端点和登出分别撤销订阅', {
  skip: !url && '需要隔离 PostgreSQL',
  timeout: 20_000,
}, async () => {
  const schema = `push_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const owner = randomUUID(), other = randomUUID()
  const secret = 'synthetic-web-push-secret'
  const { publicKey, privateKey } = generateVAPIDKeys()
  const errors: unknown[] = []
  const outgoing: Array<{ url: string; encrypted: boolean }> = []
  const push = createWebPush(pool, {
    GUGU_WEB_PUSH_PUBLIC_KEY: publicKey, GUGU_WEB_PUSH_PRIVATE_KEY: privateKey,
    GUGU_WEB_PUSH_SUBJECT: 'mailto:push@example.test',
  }, error => errors.push(error), {
    async request(request) {
      outgoing.push({ url: request.url, encrypted: Buffer.isBuffer(request.body) && !request.body.includes('合成提醒') })
      return { status: 410, headers: {}, body: (async function* () {})(), cancel() {} }
    },
  })!
  const app = createApp({
    appName: 'Gugu', isReady: async () => true, webPush: push,
    userAuth: {
      secret, lookupUser: async id => ({
        id, username: 'synthetic', displayName: null, email: 'synthetic@example.test', isActive: true,
        accountStatus: 'active', securityVersion: 1, avatarUrl: null, createdAt: null,
        timezone: null, emailSubscribed: false, imChannels: [],
      }),
      async revokeUserSessions() {},
      async publishAuthStateChanged() {},
    },
  })
  const subscriptions = '/api/v1/notifications/push/subscriptions'
  const headers = (id: string) => ({ authorization: `Bearer ${signedUserToken(secret, id)}` })
  const browserKey = createECDH('prime256v1').generateKeys().toString('base64url')
  const keys = { p256dh: browserKey, auth: randomBytes(16).toString('base64url') }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await migratePostgres(pool, 'apply')
    assert.equal(await migratePostgres(pool, 'check'), 'applied')
    for (const id of [owner, other]) {
      await pool.query('INSERT INTO users(id,username,email,hashed_password) VALUES($1,$2,$3,$4)',
        [id, id, `${id}@example.test`, 'synthetic'])
    }
    const subscribe = (id: string, endpoint: string) => app.inject({
      method: 'POST', url: subscriptions, headers: headers(id), payload: { endpoint, keys },
    })
    assert.equal((await subscribe(owner, 'https://localhost/private')).statusCode, 422)
    const ownerResponse = await subscribe(owner, 'https://fcm.googleapis.com/fcm/send/example-owner')
    assert.equal(ownerResponse.statusCode, 200, ownerResponse.body)
    const ownerSubscription = ownerResponse.json().id
    const otherResponse = await subscribe(other, 'https://fcm.googleapis.com/fcm/send/example-other')
    assert.equal(otherResponse.statusCode, 200, otherResponse.body)
    const otherSubscription = otherResponse.json().id
    const deliver = createPostgresScheduledTaskTestDelivery(pool, async () => true, {
      webPushKey: publicKey, async email() { throw new Error('未选择邮件') },
    })
    assert.deepEqual(await deliver({ ownerId: owner, channels: ['web'], title: '合成提醒', text: '合成提醒' }), { 'web 通知': '已发送' })
    assert.deepEqual((await pool.query('SELECT subscription_id FROM web_push_outbox')).rows,
      [{ subscription_id: ownerSubscription }])
    push.start()
    for (let n = 0; n < 100; n++) {
      if (!(await pool.query('SELECT 1 FROM web_push_outbox')).rowCount || errors.length) break
      await wait(20)
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(outgoing, [{ url: 'https://fcm.googleapis.com/fcm/send/example-owner', encrypted: true }])
    assert.deepEqual((await app.inject({ url: `${subscriptions}/${ownerSubscription}`, headers: headers(owner) })).json(), { active: false })
    for (const id of [owner, other]) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout',
        headers: { ...headers(id), 'x-gugu-push-subscription': otherSubscription },
      })
      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual((await app.inject({ url: `${subscriptions}/${otherSubscription}`, headers: headers(other) })).json(),
        { active: id !== other })
    }
  } finally {
    await push.close()
    await app.close()
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end() }
  }
})
