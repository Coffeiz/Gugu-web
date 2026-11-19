import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

export interface LogoutUser {
  readonly id: string
}

export interface LogoutRouteOptions {
  authenticate: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<LogoutUser | null>
  /** Resolves only after the new security version has been committed. */
  revokeUserSessions: (userId: string) => Promise<void>
  /** The notifier owns diagnostic logging; notification failure is non-fatal. */
  publishAuthStateChanged: (userId: string) => Promise<unknown>
}

export function registerLogoutRoute(app: FastifyInstance, options: LogoutRouteOptions): void {
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const user = await options.authenticate(request, reply)
    if (!user) return

    await options.revokeUserSessions(user.id)
    try {
      await options.publishAuthStateChanged(user.id)
    } catch {
      // Session revocation is already durable; a missed live notification must not undo it.
    }

    reply.header('set-cookie', [
      'gugu_user_access_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
      'gugu_user_csrf_token=; Max-Age=0; Path=/; SameSite=Lax',
    ])
    return { ok: true }
  })
}
