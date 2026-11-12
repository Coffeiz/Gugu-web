import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { CoreError } from '@gugu/core'
import { authenticateUser, AuthenticationError, type PublicUserRecord } from './auth.js'

export interface UserAuthOptions {
  secret: string
  lookupUser: (userId: string) => Promise<PublicUserRecord | null>
  markUserActive?: (userId: string) => Promise<void>
}

export interface ClientResponse {
  id: number
  name: string
  contact: string | null
  email: string | null
  phone: string | null
  notes: string
}

export interface ClientCreateInput extends Record<string, unknown> {
  name: string
  contact?: string | null
  email?: string | null
  phone?: string | null
  notes: string
}

export interface ClientOptions {
  list: (ownerId: string) => Promise<ClientResponse[]>
  create: (ownerId: string, input: ClientCreateInput) => Promise<ClientResponse>
  delete: (ownerId: string, clientId: number) => Promise<void>
}

export interface EventOptions {
  list: (ownerId: string, year?: number, month?: number) => Promise<unknown[]>
  get: (ownerId: string, eventId: number) => Promise<unknown | null>
}

export interface NotificationOptions {
  list: (ownerId: string, userCreatedAt: Date | string, limit: number) => Promise<unknown[]>
  latestBubble: (ownerId: string, userCreatedAt: Date | string) => Promise<unknown>
  markRead: (ownerId: string, userCreatedAt: Date | string, ids: number[] | null) => Promise<number>
  clear: (ownerId: string, userCreatedAt: Date | string) => Promise<number>
}

export interface WebUiOptions {
  appName: string
  isReady: () => Promise<boolean>
  onReadinessError?: () => void
  userAuth?: UserAuthOptions
  listProjects?: (ownerId: string, archived: boolean, deleted?: boolean) => Promise<unknown[]>
  listProjectFileCounts?: (ownerId: string) => Promise<unknown[]>
  getProject?: (ownerId: string, projectId: number) => Promise<unknown | null>
  clients?: ClientOptions
  events?: EventOptions
  notifications?: NotificationOptions
}

function userResponse(user: PublicUserRecord) {
  const createdAt = user.createdAt instanceof Date
    ? user.createdAt.toISOString().slice(0, 10)
    : user.createdAt?.slice(0, 10) ?? ''
  return {
    id: user.id,
    username: user.username,
    display_name: user.displayName,
    email: user.email,
    is_active: user.isActive,
    avatar_url: user.avatarUrl,
    created_at: createdAt,
    im_channels: user.imChannels,
    timezone: user.timezone,
    email_subscribed: user.emailSubscribed,
  }
}

async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: UserAuthOptions,
): Promise<PublicUserRecord | null> {
  try {
    const { user } = await authenticateUser({
      method: request.method,
      authorization: typeof request.headers.authorization === 'string'
        ? request.headers.authorization
        : undefined,
      cookie: request.headers.cookie,
      csrfHeader: typeof request.headers['x-csrf-token'] === 'string'
        ? request.headers['x-csrf-token']
        : undefined,
    }, auth.secret, auth.lookupUser)
    await auth.markUserActive?.(user.id)
    return user
  } catch (error) {
    if (error instanceof AuthenticationError) {
      reply.code(error.statusCode).send({ detail: error.message })
      return null
    }
    throw error
  }
}

async function getCurrentUser(request: FastifyRequest, reply: FastifyReply, auth: UserAuthOptions) {
  const user = await authenticateRequest(request, reply, auth)
  return user ? userResponse(user) : undefined
}

function parseClientCreate(body: unknown): ClientCreateInput | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  if (typeof value.name !== 'string') return null
  for (const key of ['contact', 'email', 'phone']) {
    const field = value[key]
    if (field !== undefined && field !== null && typeof field !== 'string') return null
  }
  if (value.notes !== undefined && typeof value.notes !== 'string') return null
  return {
    name: value.name,
    ...(value.contact === undefined ? {} : { contact: value.contact as string | null }),
    ...(value.email === undefined ? {} : { email: value.email as string | null }),
    ...(value.phone === undefined ? {} : { phone: value.phone as string | null }),
    notes: (value.notes as string | undefined) ?? '',
  }
}

function sendCoreError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof CoreError)) throw error
  const status = error.code === 'invalid_request' ? 422
    : error.code === 'not_found' ? 404
      : error.code === 'conflict' ? 409 : undefined
  if (status === undefined) throw error
  return reply.code(status).send({ detail: error.message })
}

function queryBoolean(query: Record<string, unknown>, key: string): boolean | undefined {
  const value = query[key]
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  return undefined
}

function queryInteger(query: Record<string, unknown>, key: string): number | null | undefined {
  const value = query[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null
  const result = Number(value)
  return Number.isSafeInteger(result) ? result : null
}

function registerProjectRoute(
  app: FastifyInstance,
  auth: UserAuthOptions,
  listProjects: NonNullable<WebUiOptions['listProjects']>,
) {
  app.get('/api/v1/projects', async (request, reply) => {
    const user = await authenticateRequest(request, reply, auth)
    if (!user) return
    const query = request.query as Record<string, unknown>
    const archived = queryBoolean(query, 'archived')
    const deleted = queryBoolean(query, 'deleted')
    if (archived === undefined || deleted === undefined)
      return reply.code(422).send({ detail: '查询参数必须是 true 或 false' })
    if (archived && deleted)
      return reply.code(400).send({ detail: 'archived 和 deleted 不能同时为 true' })
    return listProjects(user.id, archived, deleted)
  })
}

function registerProjectGetRoute(
  app: FastifyInstance,
  auth: UserAuthOptions,
  getProject: NonNullable<WebUiOptions['getProject']>,
) {
  app.get('/api/v1/projects/:projectId', async (request, reply) => {
    const user = await authenticateRequest(request, reply, auth)
    if (!user) return
    const rawId = (request.params as { projectId: string }).projectId
    const projectId = Number(rawId)
    if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(projectId) || projectId < 1)
      return reply.code(422).send({ detail: '项目标识无效' })
    const project = await getProject(user.id, projectId)
    if (project === null) return reply.code(404).send({ detail: '项目不存在' })
    return project
  })
}

function registerProjectFileCountsRoute(
  app: FastifyInstance,
  auth: UserAuthOptions,
  listProjectFileCounts: NonNullable<WebUiOptions['listProjectFileCounts']>,
) {
  app.get('/api/v1/projects/file-counts', async (request, reply) => {
    const user = await authenticateRequest(request, reply, auth)
    if (!user) return
    return listProjectFileCounts(user.id)
  })
}

function registerClientRoutes(app: FastifyInstance, auth: UserAuthOptions, clients: ClientOptions) {
  app.get('/api/v1/clients', async (request, reply) => {
    const user = await authenticateRequest(request, reply, auth)
    if (!user) return
    return clients.list(user.id)
  })
  app.post('/api/v1/clients', async (request, reply) => {
    const user = await authenticateRequest(request, reply, auth)
    if (!user) return
    const input = parseClientCreate(request.body)
    if (!input) return reply.code(422).send({ detail: '联系人请求字段无效' })
    try {
      return reply.code(201).send(await clients.create(user.id, input))
    } catch (error) {
      return sendCoreError(reply, error)
    }
  })
  app.delete('/api/v1/clients/:clientId', async (request, reply) => {
    const user = await authenticateRequest(request, reply, auth)
    if (!user) return
    const rawId = (request.params as { clientId: string }).clientId
    if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) < 1)
      return reply.code(422).send({ detail: '联系人标识无效' })
    try {
      await clients.delete(user.id, Number(rawId))
      return reply.code(204).send()
    } catch (error) {
      return sendCoreError(reply, error)
    }
  })
}

function registerEventRoutes(app: FastifyInstance, auth: UserAuthOptions, events: EventOptions) {
  app.get('/api/v1/events', async (request, reply) => {
    const user = await authenticateRequest(request, reply, auth)
    if (!user) return
    const query = request.query as Record<string, unknown>
    const year = queryInteger(query, 'year')
    const month = queryInteger(query, 'month')
    if (year === null || month === null)
      return reply.code(422).send({ detail: '年份或月份无效' })
    return events.list(user.id, year, month)
  })
  app.get('/api/v1/events/:eventId', async (request, reply) => {
    const user = await authenticateRequest(request, reply, auth)
    if (!user) return
    const rawId = (request.params as { eventId: string }).eventId
    const eventId = /^\d+$/.test(rawId) ? Number(rawId) : Number.NaN
    if (!Number.isSafeInteger(eventId) || eventId < 1)
      return reply.code(422).send({ detail: '事件标识无效' })
    const event = await events.get(user.id, eventId)
    if (event === null) return reply.code(404).send({ detail: '事件不存在' })
    return event
  })
}

function notificationOwnerCreatedAt(user: PublicUserRecord) {
  if (!user.createdAt) throw new Error('用户注册时间缺失')
  return user.createdAt
}

function parseNotificationRead(body: unknown): number[] | null | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const ids = (body as Record<string, unknown>).ids
  if (ids === undefined || ids === null) return null
  if (!Array.isArray(ids)) return undefined
  const parsed: number[] = []
  for (const id of ids) {
    const value = typeof id === 'number' ? id : typeof id === 'string' && /^-?\d+$/.test(id) ? Number(id) : Number.NaN
    if (!Number.isSafeInteger(value)) return undefined
    parsed.push(value)
  }
  return parsed
}

function registerNotificationRoutes(app: FastifyInstance, auth: UserAuthOptions, notifications: NotificationOptions) {
  app.get('/api/v1/notifications', async (request, reply) => {
    const user = await authenticateRequest(request, reply, auth)
    if (!user) return
    const rawLimit = queryInteger(request.query as Record<string, unknown>, 'limit')
    if (rawLimit === null) return reply.code(422).send({ detail: 'limit 必须是整数' })
    return notifications.list(user.id, notificationOwnerCreatedAt(user), rawLimit ?? 30)
  })
  app.get('/api/v1/notifications/bubble', async (request, reply) => {
    const user = await authenticateRequest(request, reply, auth)
    if (!user) return
    return notifications.latestBubble(user.id, notificationOwnerCreatedAt(user))
  })
  app.post('/api/v1/notifications/read', async (request, reply) => {
    const user = await authenticateRequest(request, reply, auth)
    if (!user) return
    const ids = parseNotificationRead(request.body)
    if (ids === undefined) return reply.code(422).send({ detail: '通知已读请求无效' })
    const marked = await notifications.markRead(user.id, notificationOwnerCreatedAt(user), ids)
    return { ok: true, marked }
  })
  app.delete('/api/v1/notifications', async (request, reply) => {
    const user = await authenticateRequest(request, reply, auth)
    if (!user) return
    const dismissed = await notifications.clear(user.id, notificationOwnerCreatedAt(user))
    return { ok: true, dismissed }
  })
}

export function createApp(options: WebUiOptions) {
  const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } })
  app.get('/health', async () => ({ status: 'ok', app: options.appName }))
  app.get('/health/ready', async (_request, reply) => {
    try {
      if (await options.isReady()) return { status: 'ok' }
    } catch {
      options.onReadinessError?.()
    }
    return reply.code(503).send({ status: 'not_ready' })
  })
  if (options.userAuth) {
    app.get('/api/v1/auth/me', (request, reply) => getCurrentUser(request, reply, options.userAuth!))
    if (options.listProjects) registerProjectRoute(app, options.userAuth, options.listProjects)
    if (options.listProjectFileCounts)
      registerProjectFileCountsRoute(app, options.userAuth, options.listProjectFileCounts)
    if (options.getProject) registerProjectGetRoute(app, options.userAuth, options.getProject)
    if (options.clients) registerClientRoutes(app, options.userAuth, options.clients)
    if (options.events) registerEventRoutes(app, options.userAuth, options.events)
    if (options.notifications) registerNotificationRoutes(app, options.userAuth, options.notifications)
  }
  return app
}
