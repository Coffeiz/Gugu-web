import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

type RequestAuthenticator<User> = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<User | null>

type AuthenticatedRoutes<User> = (
  routes: FastifyInstance,
  getUser: (request: FastifyRequest) => User,
) => void

const authenticatedUsers = new WeakMap<FastifyRequest, unknown>()

/** 注册一个受保护的业务域；认证在域级 preHandler 中只执行一次。 */
export function registerAuthenticatedDomain<User>(
  app: FastifyInstance,
  authenticate: RequestAuthenticator<User>,
  registerRoutes: AuthenticatedRoutes<User>,
): FastifyInstance {
  return app.register(async (routes) => {
    routes.addHook('preHandler', async (request, reply) => {
      const user = await authenticate(request, reply)
      if (user === null) {
        if (!reply.sent) reply.code(401).send({ detail: '认证失败' })
        return
      }
      authenticatedUsers.set(request, user)
    })
    registerRoutes(routes, (request) => authenticatedUser<User>(request))
  })
}

/** 读取业务域 preHandler 写入请求的可信身份。 */
export function authenticatedUser<User>(request: FastifyRequest): User {
  const user = authenticatedUsers.get(request)
  if (user === undefined) throw new Error('受保护路由缺少认证上下文')
  return user as User
}
