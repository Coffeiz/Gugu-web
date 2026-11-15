import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createAgentRunCodec } from '../../../src/agent/run/codec.js'
import type { RunCheckpoint, RunEvent, RunIdentity } from '../../../src/agent/models.js'

const identity: RunIdentity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '1', runId: 'run' }
const checkpoint = { identity, version: 2, sequence: 1, status: 'running', context: null } as unknown as RunCheckpoint<unknown>
const event: RunEvent = { identity, id: 'event-1', sequence: 1, round: 1, type: 'run_started', payload: {} }
const secret = '合成密钥'
function legacy(value: unknown, kind: string, id: string) {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from('gugu-agent-run-store-v1'), 32))
  const nonce = Buffer.alloc(12, 7), cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(`${identity.ownerId}\n${identity.sessionId}\n${identity.runId}\n${kind}\n${id}`))
  return { nonce, payload: Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]) }
}
describe('Agent Run codec', () => {
  it('读取旧 Web 密文，验证 checkpoint 版本及事件序号', () => {
    const codec = createAgentRunCodec(secret), state = legacy(checkpoint, 'checkpoint', 'current'), stored = legacy(event, 'event', event.id)
    expect(codec.decryptCheckpoint(identity, 2, state.nonce, state.payload)).toEqual(checkpoint)
    expect(codec.decryptEvent(identity, event.id, 1, stored.nonce, stored.payload)).toEqual(event)
    const fresh = codec.encryptCheckpoint(checkpoint)
    const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from('gugu-agent-run-store-v1'), 32))
    const reader = createDecipheriv('aes-256-gcm', key, fresh.nonce)
    reader.setAAD(Buffer.from(`${identity.ownerId}\n${identity.sessionId}\n${identity.runId}\ncheckpoint\ncurrent`))
    reader.setAuthTag(fresh.payload.subarray(-16))
    expect(JSON.parse(Buffer.concat([reader.update(fresh.payload.subarray(0, -16)), reader.final()]).toString('utf8'))).toEqual(checkpoint)
    expect(() => codec.decryptCheckpoint(identity, 3, state.nonce, state.payload)).toThrow('版本不一致')
    expect(() => codec.decryptEvent(identity, event.id, 2, stored.nonce, stored.payload)).toThrow('outbox 内容无效')
  })
  it('跨 owner、session、run、事件身份及密文篡改均失败，错误不泄漏正文或密钥', () => {
    const codec = createAgentRunCodec(secret), state = codec.encryptCheckpoint(checkpoint), stored = codec.encryptEvent(identity, event)
    for (const other of [{ ...identity, ownerId: '00000000-0000-4000-8000-000000000002' }, { ...identity, sessionId: '2' }, { ...identity, runId: 'other' }]) {
      expect(() => codec.decryptCheckpoint(other, 2, state.nonce, state.payload)).toThrow('无法安全解密')
      expect(() => codec.decryptEvent(other, event.id, 1, stored.nonce, stored.payload)).toThrow('无法安全解密')
    }
    expect(() => codec.decryptEvent(identity, 'other-event', 1, stored.nonce, stored.payload)).toThrow('无法安全解密')
    const tampered = Buffer.from(state.payload); tampered[0] = tampered[0]! ^ 1
    expect(() => codec.decryptCheckpoint(identity, 2, state.nonce, tampered)).toThrow('无法安全解密')
    expect(() => createAgentRunCodec('错误密钥').decryptCheckpoint(identity, 2, state.nonce, state.payload)).toThrow('无法安全解密')
  })
})
