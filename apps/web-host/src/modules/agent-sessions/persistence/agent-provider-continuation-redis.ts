import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import type { ProviderContinuationStore } from '@gugu/core/providers'
import type { createRedisExpiringValueStore } from '../../../adapters/redis-events.js'

/** 续接值仅短期存入 Redis。检查点、对话历史及事件中只容纳引用。 */
export function createRedisProviderContinuationStore(
  redis: Pick<ReturnType<typeof createRedisExpiringValueStore>, 'get' | 'saveIfAbsent'>,
  secret: string,
): ProviderContinuationStore {
  const key = Buffer.from(hkdfSync('sha256', secret, '', 'gugu-agent-provider-continuation-v1', 32))
  function address(scope: Parameters<ProviderContinuationStore['read']>[0], reference: string) {
    const { ownerId, sessionId, runId } = scope.identity
    const digest = createHash('sha256').update(JSON.stringify([ownerId, sessionId, runId, scope.modelIdentity, scope.accessScopeHash, reference])).digest('hex')
    return `agent-provider-continuation:v1:${digest}`
  }

  return {
    async save(scope, reference, value, ttlMs) {
      const name = address(scope, reference)
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce).setAAD(Buffer.from(name))
      const ciphertext = Buffer.concat([nonce, cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()])
      if (!await redis.saveIfAbsent(name, ciphertext.toString('base64'), Math.ceil(ttlMs / 1000)))
        throw new Error('模型续接引用冲突')
    },
    async read(scope, reference) {
      const name = address(scope, reference)
      const encoded = await redis.get(name)
      if (encoded === null) return null
      const ciphertext = Buffer.from(encoded, 'base64')
      if (ciphertext.length < 28) return null
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, 12))
          .setAAD(Buffer.from(name)).setAuthTag(ciphertext.subarray(-16))
        return JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(12, -16)), decipher.final()]).toString('utf8'))
      } catch {
        return null
      }
    },
  }
}
