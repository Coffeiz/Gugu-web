import { describe, expect, it, vi } from 'vitest'
import { createConfirmationGate } from '../../../src/agent/tools/confirmation.js'
import type { ConfirmationBinding, ConfirmationIntent, ConfirmationTargetSnapshot } from '../../../src/agent/tools/confirmation.js'
import type { ToolScope } from '../../../src/agent/tools/contracts.js'

function fixture() {
  const call = { id: 'call', name: 'delete_client', input: { client_id: 1, confirm: true, targets: [999] } }
  const scope: ToolScope = { identity: { ownerId: 'owner', sessionId: 'session', runId: 'run' }, roundId: 'round', signal: new AbortController().signal, execute: vi.fn(), resolution: null }
  const binding: ConfirmationBinding = { ...scope.identity, roundId: scope.roundId, toolCallId: call.id, toolName: call.name, normalizedInputDigest: 'trusted-normalized-digest' }
  const targets: ConfirmationTargetSnapshot = { targetsDigest: 'resolved-target-1', versionsDigest: 'version-1' }
  const intent: ConfirmationIntent = { schemaVersion: 2, binding, intentId: 'intent', interactionId: 'interaction', operationId: 'operation', purpose: 'action', action: 'delete_client', targetsDigest: 'resolved-target-1', versionsDigest: 'version-1', authorizationEpoch: 'epoch-1', expiresAt: 200 }
  const receipt = { schemaVersion: 2, intentId: intent.intentId, interactionId: intent.interactionId, receiptId: 'receipt', binding, purpose: intent.purpose, action: intent.action, status: 'approved', expiresAt: 190 }
  const ports = { now: () => 100, authorize: vi.fn(async () => 'epoch-1' as string | null), prepare: vi.fn(async (_binding: ConfirmationBinding, _targets: ConfirmationTargetSnapshot): Promise<unknown> => intent), load: vi.fn(async (): Promise<unknown> => ({ intent, receipt })), inspect: vi.fn(async () => ({ targetsDigest: 'resolved-target-1', versionsDigest: 'version-1' })) }
  const gate = createConfirmationGate(ports, { purpose: 'action', action: 'delete_client' })
  const resumed = { ...scope, resolution: { interactionId: intent.interactionId, receiptId: receipt.receiptId, status: 'confirmed' as const, value: { confirm: true, targets: [999] } } }
  const claimReference = { intentId: intent.intentId, operationId: intent.operationId, interactionId: intent.interactionId,
    receiptId: receipt.receiptId, binding, purpose: intent.purpose, action: intent.action, targetsDigest: intent.targetsDigest,
    versionsDigest: intent.versionsDigest, authorizationEpoch: intent.authorizationEpoch, expiresAt: intent.expiresAt }
  return { gate, ports, call, scope, resumed, binding, targets, intent, receipt, claimReference }
}
describe('可信确认意图核验（不含授权claim或危险业务执行）', () => {
  it('向可信存储传递领域固定目标的独立快照，不采用模型中的目标', async () => {
    const f = fixture()
    const ids = [1, 2]
    const targets = { ...f.targets, targetIds: { eventIds: ids } }
    f.ports.prepare.mockImplementation(async (_binding, snapshot) => {
      expect(snapshot.targetIds).toEqual({ eventIds: [1, 2] })
      ids.push(3)
      expect(snapshot.targetIds).toEqual({ eventIds: [1, 2] })
      expect(Object.isFrozen(snapshot.targetIds?.eventIds)).toBe(true)
      return f.intent
    })
    expect((await f.gate.prepare(f.call, f.scope, f.binding.normalizedInputDigest, targets)).ok).toBe(true)
  })
  it('恢复确认等待存储期间目标与回答被修改，不改变本次核验绑定', async () => {
    const f = fixture()
    const targets = { ...f.targets, targetIds: { eventIds: [1] } }
    f.ports.load.mockImplementation(async () => {
      targets.targetsDigest = 'changed'
      targets.targetIds.eventIds.push(2)
      f.resumed.resolution.receiptId = 'changed'
      return { intent: f.intent, receipt: f.receipt }
    })
    expect(await f.gate.verify(f.call, f.resumed, f.binding.normalizedInputDigest, targets)).toEqual({ ok: true, value: f.claimReference })
  })
  it('只保存可信scope与摘要，模型confirm/targets不参与授权，核验只返回受限引用', async () => {
    const f = fixture()
    expect(await f.gate.prepare(f.call, f.scope, f.binding.normalizedInputDigest, f.targets)).toEqual({ ok: true, value: { id: 'interaction', kind: 'confirmation', toolCall: f.call } })
    expect(f.ports.prepare).toHaveBeenCalledWith(f.binding, f.targets, f.scope.signal)
    expect(await f.gate.verify(f.call, f.resumed, f.binding.normalizedInputDigest, f.targets)).toEqual({ ok: true, value: f.claimReference })
    expect(f.scope.execute).not.toHaveBeenCalled()
  })
  it.each(['ownerId', 'sessionId', 'runId', 'roundId', 'toolCallId', 'toolName', 'normalizedInputDigest'] as const)('拒绝旧意图的异%s绑定', async key => {
    const f = fixture()
    f.intent.binding = { ...f.binding, [key]: 'other' }
    expect(await f.gate.verify(f.call, f.resumed, f.binding.normalizedInputDigest, f.targets)).toEqual({ ok: false, code: 'confirmation_rejected' })
  })
  it.each(['answered', 'cancelled', 'expired', 'aborted'] as const)('拒绝%s回答，不查询授权存储', async status => {
    const f = fixture()
    expect((await f.gate.verify(f.call, { ...f.resumed, resolution: { ...f.resumed.resolution, status } }, f.binding.normalizedInputDigest, f.targets)).ok).toBe(false)
    expect(f.ports.load).not.toHaveBeenCalled()
  })
  it('拒绝伪造receipt、跨interaction、过期与目的混用', async () => {
    for (const patch of [{ receiptId: 'fake' }, { interactionId: 'fake' }, { expiresAt: 99 }, { purpose: 'authorization' }, { action: 'other' }]) {
      const f = fixture(); Object.assign(f.receipt, patch)
      expect((await f.gate.verify(f.call, f.resumed, f.binding.normalizedInputDigest, f.targets)).ok).toBe(false)
    }
  })
  it('目标集合、版本、权限变动及过期均不能形成可用引用', async () => {
    const variants = [ { targetsDigest: 'changed' }, { versionsDigest: 'changed' } ]
    for (const changed of variants) {
      const f = fixture(); f.ports.inspect.mockResolvedValue({ targetsDigest: f.intent.targetsDigest, versionsDigest: f.intent.versionsDigest, ...changed })
      expect((await f.gate.verify(f.call, f.resumed, f.binding.normalizedInputDigest, f.targets)).ok).toBe(false)
    }
    const f = fixture(); f.ports.authorize.mockResolvedValue('epoch-2')
    expect((await f.gate.verify(f.call, f.resumed, f.binding.normalizedInputDigest, f.targets)).ok).toBe(false)
    f.ports.authorize.mockResolvedValue(null)
    expect((await f.gate.prepare(f.call, f.scope, f.binding.normalizedInputDigest, f.targets)).ok).toBe(false)
    expect(f.ports.prepare).not.toHaveBeenCalled()
  })
  it('准备和恢复必须绑定可信领域解析出的目标与版本摘要', async () => {
    const f = fixture()
    const changed = { targetsDigest: 'other-target', versionsDigest: 'other-version' }
    expect((await f.gate.prepare(f.call, f.scope, f.binding.normalizedInputDigest, changed)).ok).toBe(false)
    expect((await f.gate.verify(f.call, f.resumed, f.binding.normalizedInputDigest, changed)).ok).toBe(false)
  })
  it('端口无法原地篡改可信绑定覆盖owner', async () => {
    const f = fixture()
    f.ports.prepare.mockImplementation(async binding => { (binding as { ownerId: string }).ownerId = 'other'; return f.intent })
    expect((await f.gate.prepare(f.call, f.scope, f.binding.normalizedInputDigest, f.targets)).ok).toBe(false)
    expect(f.scope.identity.ownerId).toBe('owner')
  })
  it('等待存储期间取消要在清理完成后传播取消异常', async () => {
    const f = fixture(); const controller = new AbortController(); let cleaned = false
    f.ports.prepare.mockImplementation(async () => { controller.abort(); await Promise.resolve(); cleaned = true; return f.intent })
    await expect(f.gate.prepare(f.call, { ...f.scope, signal: controller.signal }, f.binding.normalizedInputDigest, f.targets)).rejects.toThrow()
    expect(cleaned).toBe(true)
  })
  it('缺失新绑定的弱意图、存储异常和取消均安全拒绝且不泄露异常', async () => {
    const f = fixture()
    f.ports.load.mockResolvedValue({ intent: { intentId: 'legacy' }, receipt: f.receipt })
    expect((await f.gate.verify(f.call, f.resumed, f.binding.normalizedInputDigest, f.targets)).ok).toBe(false)
    f.ports.load.mockRejectedValue(new Error('synthetic-secret'))
    expect(await f.gate.verify(f.call, f.resumed, f.binding.normalizedInputDigest, f.targets)).toEqual({ ok: false, code: 'confirmation_rejected' })
    const controller = new AbortController(); controller.abort()
    await expect(f.gate.prepare(f.call, { ...f.scope, signal: controller.signal }, f.binding.normalizedInputDigest, f.targets)).rejects.toThrow()
    expect(f.ports.prepare).not.toHaveBeenCalled()
  })
})


it('授权中取消并返回拒绝时仍传播取消，不进入存储', async () => {
  const f = fixture(); const controller = new AbortController()
  f.ports.authorize.mockImplementation(async () => { controller.abort(); return null })
  await expect(f.gate.prepare(f.call, { ...f.scope, signal: controller.signal }, f.binding.normalizedInputDigest, f.targets)).rejects.toThrow()
  expect(f.ports.prepare).not.toHaveBeenCalled()
})
it('查询存储中取消并返回旧意图时仍传播取消', async () => {
  const f = fixture(); const controller = new AbortController()
  f.ports.load.mockImplementation(async () => { controller.abort(); return { intentId: 'legacy' } })
  await expect(f.gate.verify(f.call, { ...f.resumed, signal: controller.signal }, f.binding.normalizedInputDigest, f.targets)).rejects.toThrow()
})
it.each([NaN, Infinity, 201])('非法时钟或意图过期%s均拒绝', async now => {
  const f = fixture(); f.ports.now = () => now
  expect((await f.gate.prepare(f.call, f.scope, f.binding.normalizedInputDigest, f.targets)).ok).toBe(false)
  expect((await f.gate.verify(f.call, f.resumed, f.binding.normalizedInputDigest, f.targets)).ok).toBe(false)
})
it('准备等待期间外部修改call不改变返回的确认调用快照', async () => {
  const f = fixture()
  f.ports.prepare.mockImplementation(async () => { f.call.input.client_id = 999; f.call.id = 'changed'; return f.intent })
  const prepared = await f.gate.prepare(f.call, f.scope, f.binding.normalizedInputDigest, f.targets)
  expect(prepared.ok && prepared.value.toolCall.id).toBe('call')
  expect(prepared.ok && prepared.value.toolCall.input).toMatchObject({ client_id: 1 })
})
