import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { RunCheckpoint, RunEvent, RunIdentity } from '../models.js'

const encryptionInfo = Buffer.from('gugu-agent-run-store-v1', 'utf8')
export function assertRunIdentity(identity: RunIdentity): void {
  if (!identity.ownerId || !identity.runId || identity.runId.length > 128) throw new TypeError('Agent run 身份无效')
  if (!/^[1-9]\d*$/.test(identity.sessionId) || !Number.isSafeInteger(Number(identity.sessionId))) throw new TypeError('Agent 会话身份无效')
}
export function sameRunIdentity(left: RunIdentity, right: RunIdentity): boolean {
  return left.ownerId === right.ownerId && left.sessionId === right.sessionId && left.runId === right.runId
}
export function assertRunCheckpoint<C>(identity: RunIdentity, checkpoint: RunCheckpoint<C>): void {
  assertRunIdentity(identity)
  if (!sameRunIdentity(identity, checkpoint.identity)) throw new TypeError('Agent run checkpoint 身份不一致')
  if (!Number.isSafeInteger(checkpoint.version) || checkpoint.version < 0 || !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0) throw new TypeError('Agent run checkpoint 版本无效')
}
function aad(identity: RunIdentity, kind: 'checkpoint' | 'event' | 'continuation', id: string): Buffer {
  return Buffer.from(`${identity.ownerId}\n${identity.sessionId}\n${identity.runId}\n${kind}\n${id}`, 'utf8')
}
function deriveKey(secretKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secretKey, 'utf8'), Buffer.alloc(0), encryptionInfo, 32))
}
/** 与既有 Web RunStore 密文格式兼容；密钥及原始异常不进入日志。 */
export function createAgentRunCodec(secretKey: string) {
  if (!secretKey) throw new TypeError('Agent run 加密密钥不能为空')
  function encrypt(identity: RunIdentity, kind: 'checkpoint' | 'event' | 'continuation', id: string, value: unknown) {
    assertRunIdentity(identity)
    const json = JSON.stringify(value)
    if (json === undefined) throw new TypeError('Agent run 状态无法序列化')
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', deriveKey(secretKey), nonce)
    cipher.setAAD(aad(identity, kind, id))
    return { nonce, payload: Buffer.concat([cipher.update(json, 'utf8'), cipher.final(), cipher.getAuthTag()]) }
  }
  function decrypt<T>(identity: RunIdentity, kind: 'checkpoint' | 'event' | 'continuation', id: string, nonce: Uint8Array, payload: Uint8Array): T {
    assertRunIdentity(identity)
    if (nonce.length !== 12 || payload.length < 16) throw new Error('Agent run 状态密文无效')
    try {
      const input = Buffer.from(payload), decipher = createDecipheriv('aes-256-gcm', deriveKey(secretKey), nonce)
      decipher.setAAD(aad(identity, kind, id)); decipher.setAuthTag(input.subarray(-16))
      return JSON.parse(Buffer.concat([decipher.update(input.subarray(0, -16)), decipher.final()]).toString('utf8')) as T
    } catch { throw new Error('Agent run 状态无法安全解密') }
  }
  return {
    encryptContinuation(identity: RunIdentity, reference: string, value: unknown) {
      return encrypt(identity, 'continuation', reference, value)
    },
    decryptContinuation<T>(identity: RunIdentity, reference: string, nonce: Uint8Array, payload: Uint8Array) {
      return decrypt<T>(identity, 'continuation', reference, nonce, payload)
    },
    encryptCheckpoint<C>(checkpoint: RunCheckpoint<C>) { assertRunCheckpoint(checkpoint.identity, checkpoint); return encrypt(checkpoint.identity, 'checkpoint', 'current', checkpoint) },
    decryptCheckpoint<C>(identity: RunIdentity, version: number, nonce: Uint8Array, payload: Uint8Array): RunCheckpoint<C> {
      const checkpoint = decrypt<RunCheckpoint<C>>(identity, 'checkpoint', 'current', nonce, payload)
      assertRunCheckpoint(identity, checkpoint)
      if (checkpoint.version !== version) throw new Error('Agent run checkpoint 版本不一致')
      return checkpoint
    },
    encryptEvent(identity: RunIdentity, event: RunEvent) {
      if (!sameRunIdentity(identity, event.identity) || !Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new TypeError('Agent run event 身份或序号无效')
      return encrypt(identity, 'event', event.id, event)
    },
    decryptEvent(identity: RunIdentity, eventId: string, sequence: number, nonce: Uint8Array, payload: Uint8Array): RunEvent {
      const event = decrypt<RunEvent>(identity, 'event', eventId, nonce, payload)
      if (event.id !== eventId || event.sequence !== sequence || !sameRunIdentity(identity, event.identity)) throw new Error('Agent run outbox 内容无效')
      return event
    },
  }
}

export function assertRunEventTransition(
  identity: RunIdentity,
  previousSequence: number,
  nextSequence: number,
  events: readonly RunEvent[],
): void {
  if (!Number.isSafeInteger(previousSequence) || !Number.isSafeInteger(nextSequence)
    || nextSequence < previousSequence)
    throw new TypeError('Agent run 事件序号不能回退')
  if (events.length === 0) {
    if (nextSequence !== previousSequence) throw new TypeError('Agent run checkpoint 序号与事件不一致')
    return
  }
  if (events.length !== 1 || nextSequence !== previousSequence + 1
    || events[0]!.sequence !== nextSequence || !sameRunIdentity(identity, events[0]!.identity))
    throw new TypeError('Agent run checkpoint 序号与事件不一致')
}
