import { domainToASCII } from 'node:url'
import type { preHandlerHookHandler } from 'fastify'

function normalizeHostname(value: string | undefined): string | null {
  if (!value) return null
  const hostname = value.trim().replace(/\.$/, '').toLowerCase()
  if (!hostname || /[/:*@]/.test(hostname)) return null
  const ascii = domainToASCII(hostname)
  return ascii || null
}

/** Match Python's optional allowlist for /api/v1/admin routes. */
export function createAdminHostGuard(configuredHosts: string): preHandlerHookHandler {
  const allowedHosts = new Set(
    configuredHosts.split(',').map((host) => normalizeHostname(host) ?? '').filter(Boolean),
  )
  return async (request, reply) => {
    if (!configuredHosts.trim()) return
    const hostname = normalizeHostname(request.hostname)
    if (!hostname || !allowedHosts.has(hostname))
      return reply.code(404).send({ detail: 'Not Found' })
  }
}
