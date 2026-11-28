import type { ProviderTransport } from '@gugu/core/providers'
import { NodeProviderTransport } from '@gugu/core/providers/node'
import { createQqFaceResolver, createQqInboundPreparation } from '@gugu/gateway/qq'
import type { ImAttachmentScope } from '../../inbound/attachments.js'
import type { RedisCommandClient } from '../../../../../workers/redis-stream-queue.js'
import { createQqReferenceStore } from './reference-store.js'

/** 仅在Core preflight通过后调用；独立Host服务负责引用持久恢复、本人FIFO和公共QFace索引。 */
export function createQqMessagePreparer(options: {
  redis: RedisCommandClient
  secretKey: string
  /** 每次准备均从当前Bot/账户策略复核，不能复用过期权限快照。 */
  authorize(scope: ImAttachmentScope, signal: AbortSignal): Promise<boolean>
  transport?: ProviderTransport
  now?(): number
  report?(code: 'qface-unavailable'): void
}) {
  const references = createQqReferenceStore(options)
  const transport = options.transport ?? new NodeProviderTransport({ trustEnvironment: false })
  const faces = createQqFaceResolver({ transport, now: options.now, report: options.report })
  const inbound = createQqInboundPreparation({ references, authorize: options.authorize, appendAssets: faces.appendAssets })
  return { prepare: inbound.prepare, async close() { inbound.close(); await faces.close(); await transport.close?.() } }
}
