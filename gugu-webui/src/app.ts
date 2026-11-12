import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { authenticateUser, AuthenticationError, type PublicUserRecord } from './auth.js'

export interface UserAuthOptions {
  secret: string
  lookupUser: (userId: string) => Promise<PublicUserRecord | null>
  markUserActive?: (userId: string) => Promise<void>
}

export interface WebUiOptions {
  appName: string
  isReady: () => Promise<boolean>
  onReadinessError?: () => void
  userAuth?: UserAuthOptions
  listProjects?: (ownerId: string, archived: boolean) => Promise<unknown[]>
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

async function getCurrentUser(request: FastifyRequest, reply: FastifyReply, auth: UserAuthOptions) {
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
    return userResponse(user)
  } catch (error) {
    if (error instanceof AuthenticationError)
      return reply.code(error.statusCode).send({ detail: error.message })
    throw error
  }
}

export function createApp(options: WebUiOptions) {
  const app = Fastify({ logger: false })
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
    if (options.listProjects) {
      app.get('/api/v1/projects', async (request, reply) => {
        const auth = options.userAuth!
        let user: PublicUserRecord
        try {
          ({ user } = await authenticateUser({
            method: request.method,
            authorization: typeof request.headers.authorization === 'string'
              ? request.headers.authorization
              : undefined,
            cookie: request.headers.cookie,
            csrfHeader: typeof request.headers['x-csrf-token'] === 'string'
              ? request.headers['x-csrf-token']
              : undefined,
          }, auth.secret, auth.lookupUser))
          await auth.markUserActive?.(user.id)
        } catch (error) {
          if (error instanceof AuthenticationError)
            return reply.code(error.statusCode).send({ detail: error.message })
          throw error
        }

        const query = request.query as Record<string, unknown>
        const parseBoolean = (key: string): boolean | undefined => {
          const value = query[key]
          if (value === undefined) return false
          if (value === 'true') return true
          if (value === 'false') return false
          return undefined
        }
        const archived = parseBoolean('archived')
        const deleted = parseBoolean('deleted')
        if (archived === undefined || deleted === undefined)
          return reply.code(422).send({ detail: '查询参数必须是 true 或 false' })
        if (archived && deleted)
          return reply.code(400).send({ detail: 'archived 和 deleted 不能同时为 true' })
        if (deleted)
          return reply.code(501).send({ detail: 'Node 后端暂不支持已删除项目列表' })
        return options.listProjects!(user.id, archived)
      })
    }
  }
  return app
}
