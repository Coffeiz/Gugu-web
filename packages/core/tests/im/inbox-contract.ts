import assert from 'node:assert/strict'
import type { InboundRecordResult } from '../../src/im/inbound-store.js'

/** 两端通过真实存储运行同一收件幂等契约。 */
export async function assertInboundRecordContract(
  record: () => Promise<InboundRecordResult>,
): Promise<string> {
  const first = await record()
  assert.ok(first.status === 'queued')
  assert.ok(first.id)
  assert.deepEqual(await record(), { status: 'duplicate' })
  return first.id
}
