import type { ProviderTransport } from '@gugu/core/providers'
import { createECDH, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { NodeProviderTransport } from '@gugu/core/providers/node'
import { generateRequestDetails } from 'web-push'
import { z } from 'zod'
import type { UserFromRequest } from '../../http/options.js'

const pushHost = /^(?:fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|(?:[a-z0-9-]+\.)+push\.apple\.com|(?:[a-z0-9-]+\.)*notify\.windows\.com)$/u
const encoded = (length: number) => z.string().regex(/^[\w-]+$/u).refine(value => {
  const bytes = Buffer.from(value, 'base64url')
  return bytes.length === length && bytes.toString('base64url') === value
})
const subscription = z.object({
  endpoint: z.string().max(2048).refine(value => {
    if (/[\x00-\x20\x7f\\]/u.test(value)) return false
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.port && !url.username && !url.password
        && !url.hash && pushHost.test(url.hostname)
    } catch { return false }
  }),
  keys: z.object({ p256dh: encoded(65), auth: encoded(16) }),
})

type Job = {
  subscription_id: string
  notification_id: number
  attempts: number
  endpoint: string
  p256dh: string
  auth: string
  ttl: number
}

export function createWebPush(pool: Pick<Pool, 'query'>, env: NodeJS.ProcessEnv, diagnose: (error: unknown) => void,
  transport?: ProviderTransport,
) {
  const { GUGU_WEB_PUSH_PUBLIC_KEY: publicKey, GUGU_WEB_PUSH_PRIVATE_KEY: privateKey, GUGU_WEB_PUSH_SUBJECT: subject } = env
  if (!publicKey && !privateKey && !subject) return
  const key = createECDH('prime256v1')
  try {
    if (!publicKey || !privateKey || !subject || !/^(mailto:|https:\/\/)/u.test(subject)) throw new Error()
    key.setPrivateKey(Buffer.from(privateKey, 'base64url'))
    if (key.getPublicKey().toString('base64url') !== publicKey || !encoded(32).safeParse(privateKey).success) throw new Error()
  } catch {
    diagnose(new Error('Web Push 的 VAPID 配置无效'))
    return
  }
  const vapidDetails = { publicKey, privateKey, subject }
  const sender = transport ?? new NodeProviderTransport({ trustEnvironment: false })
  let timer: ReturnType<typeof setInterval> | undefined
  let running: Promise<void> | undefined

  async function drain() {
    await pool.query('DELETE FROM web_push_outbox WHERE expires_at <= now()')
    for (let count = 0; count < 20 && timer; count++) {
      const { rows: [job] } = await pool.query<Job>(`
        WITH next AS (
          SELECT j.subscription_id, j.notification_id
          FROM web_push_outbox j JOIN web_push_subscriptions s ON s.id=j.subscription_id
          WHERE j.ready_at<=now() AND j.expires_at>now() AND s.vapid_key=$1
          ORDER BY j.ready_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED
        )
        UPDATE web_push_outbox j SET attempts=j.attempts+1, ready_at=now()+interval '1 minute'
        FROM next n, web_push_subscriptions s
        WHERE j.subscription_id=n.subscription_id AND j.notification_id=n.notification_id AND s.id=n.subscription_id
        RETURNING j.subscription_id,j.notification_id,j.attempts,s.endpoint,s.p256dh,s.auth,
          floor(extract(epoch FROM j.expires_at-now()))::integer AS ttl
      `, [publicKey])
      if (!job) return
      let status: number | undefined
      try {
        const data = generateRequestDetails({
          endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth },
        }, JSON.stringify({ id: job.notification_id }), {
          vapidDetails, TTL: Math.max(0, job.ttl), topic: `gugu-${job.notification_id}`,
        })
        const headers = Object.fromEntries(Object.entries(data.headers)
          .filter(([name]) => name.toLowerCase() !== 'content-length')
          .map(([name, value]) => [name, String(value)]))
        const response = await sender.request({
          url: data.endpoint, method: 'POST', headers, body: data.body ?? undefined, timeoutMs: 8_000,
        }, AbortSignal.timeout(10_000))
        status = response.status
        await response.cancel()
      } catch {
        // 网络失败保留任务，等待下次投递。
      }
      if (status === 404 || status === 410) {
        await pool.query('DELETE FROM web_push_subscriptions WHERE id=$1', [job.subscription_id])
      } else if ((status !== undefined && status < 500 && status !== 429 && status !== 408) || job.attempts >= 6) {
        await pool.query('DELETE FROM web_push_outbox WHERE subscription_id=$1 AND notification_id=$2 AND attempts=$3',
          [job.subscription_id, job.notification_id, job.attempts])
      } else {
        await pool.query(`UPDATE web_push_outbox SET ready_at=now()+$4*interval '1 second'
          WHERE subscription_id=$1 AND notification_id=$2 AND attempts=$3`,
          [job.subscription_id, job.notification_id, job.attempts, 15 * 2 ** job.attempts])
      }
    }
  }

  return {
    publicKey,
    register(app: FastifyInstance, userFromRequest: UserFromRequest) {
      const owner = (request: Parameters<UserFromRequest>[0]) => userFromRequest(request).requestContext.data.ownerId
      app.get('/api/v1/notifications/push/key', async () => ({ publicKey }))
      app.post('/api/v1/notifications/push/subscriptions', async (request, reply) => {
        const data = subscription.safeParse(request.body)
        if (!data.success) return reply.code(422).send({ detail: '浏览器推送订阅无效或推送服务暂不支持' })
        const { endpoint, keys } = data.data
        const { rows: [row] } = await pool.query<{ id: string }>(`
          INSERT INTO web_push_subscriptions(id,owner_id,endpoint,p256dh,auth,vapid_key) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, vapid_key=excluded.vapid_key
          WHERE web_push_subscriptions.owner_id=excluded.owner_id RETURNING id
        `, [randomUUID(), owner(request), endpoint, keys.p256dh, keys.auth, publicKey])
        if (!row) return reply.code(409).send({ detail: '此浏览器订阅已绑定其他账号' })
        return row
      })
      app.get<{ Params: { id: string } }>('/api/v1/notifications/push/subscriptions/:id', async request => {
        if (!z.uuid().safeParse(request.params.id).success) return { active: false }
        const { rowCount } = await pool.query(
          'SELECT 1 FROM web_push_subscriptions WHERE owner_id=$1 AND id=$2 AND vapid_key=$3',
          [owner(request), request.params.id, publicKey],
        )
        return { active: rowCount === 1 }
      })
      app.delete<{ Params: { id: string } }>('/api/v1/notifications/push/subscriptions/:id', async (request, reply) => {
        await remove(owner(request), request.params.id)
        return reply.code(204).send()
      })
    },
    remove,
    start() {
      if (timer) return
      const tick = () => {
        if (!running) running = drain().catch(diagnose).finally(() => { running = undefined })
      }
      timer = setInterval(tick, 5_000)
      timer.unref()
      tick()
    },
    async close() {
      clearInterval(timer)
      timer = undefined
      await sender.close?.()
      await running
    },
  }

  async function remove(ownerId: string, id: unknown) {
    if (!z.uuid().safeParse(id).success) return
    await pool.query('DELETE FROM web_push_subscriptions WHERE owner_id=$1 AND id=$2', [ownerId, id])
  }
}
