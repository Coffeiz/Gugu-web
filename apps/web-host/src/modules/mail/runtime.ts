import { sanitizeEmailHtml } from '@gugu/core/email/smtp-test'
import { resolvePinnedTarget } from '@gugu/core/providers/node'
import { createCachedMailService } from '@gugu/email/cached-service'
import { createMailReadCache } from '@gugu/email/read-cache'
import { createMailTransport } from '@gugu/email/transport'
import { createWebMailStore, createWebMailCacheStore } from './store.js'

function createRuntime(env: NodeJS.ProcessEnv) {
  const store = createWebMailStore(env)
  const transport = createMailTransport({
    sanitizeHtml: sanitizeEmailHtml,
    async resolveAddress(host, port) {
      return (await resolvePinnedTarget(`https://${host}:${port}`, { timeoutMs: 5_000 })).target.address
    },
  })
  const cache = createMailReadCache(createWebMailCacheStore(env))
  return { store, ...createCachedMailService(store, transport, cache) }
}

const runtimes = new WeakMap<NodeJS.ProcessEnv, ReturnType<typeof createRuntime>>()

export function createWebMailRuntime(env: NodeJS.ProcessEnv) {
  const existing = runtimes.get(env)
  if (existing) return existing
  const runtime = createRuntime(env)
  runtimes.set(env, runtime)
  return runtime
}
