import { isIP } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { mutateConfigOverride, readConfigOverride } from '../../adapters/config/config-override-file.js'
import { createPosixConfigFileLock } from '../../adapters/config/posix-config-lock.js'
import type { AdminConfigOptions } from './config.js'

const target = z.string().trim().max(64).refine(value => {
  const [address, prefix, extra] = value.split('/')
  const family = isIP(address ?? '')
  if (!family || extra !== undefined) return false
  return prefix === undefined || (/^[1-9]\d{0,2}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128))
})
const port = z.number().int().min(1).max(65535)
const rule = z.strictObject({
  target,
  protocol: z.enum(['tcp', 'udp']),
  ports: z.array(port).min(1).max(64),
})
export const sandboxNetworkPolicy = z.strictObject({
  mode: z.enum(['offline', 'public', 'private']),
  privateAccess: z.enum(['specified', 'all']),
  rules: z.array(rule).max(128),
})

export function registerSandboxNetworkRoutes(app: FastifyInstance, options: AdminConfigOptions): void {
  const url = '/api/v1/admin/sandbox/network'
  const lock = createPosixConfigFileLock()
  const project = (configured: z.infer<typeof sandboxNetworkPolicy>) => ({
    configured,
    effectiveMode: 'offline',
    ready: false,
  })
  app.get(url, { preHandler: options.requireAdmin }, async () => {
    const value = readConfigOverride(options.path).sandbox
    const stored = value && typeof value === 'object' && 'direct_network_policy' in value ? value.direct_network_policy : undefined
    return project(stored === undefined ? { mode: 'offline', privateAccess: 'specified', rules: [] } : sandboxNetworkPolicy.parse(stored))
  })
  app.patch(url, { preHandler: options.requireAdmin }, async (request, reply) => {
    const parsed = sandboxNetworkPolicy.safeParse(request.body)
    if (!parsed.success) return reply.code(422).send({ detail: '网络策略无效，请检查目标 IP、网段、协议和端口' })
    const configured = parsed.data
    await mutateConfigOverride(options.path, document => {
      const sandbox = document.sandbox
      if (sandbox !== undefined && (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox)))
        throw new Error('沙盒配置格式无效')
      document.sandbox = { ...sandbox, direct_network_policy: configured }
    }, lock)
    return project(configured)
  })
}
