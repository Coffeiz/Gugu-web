import { createHash } from 'node:crypto'
import { describe,expect,it,vi } from 'vitest'
import type { CanonicalCompletionInput } from "../../../../src/agent/harness/index.js"
import { createReflectionFinalizer,MessageArea,ReflectionSnapshots,stableJson } from "../../../../src/agent/harness/index.js"

function fixture() {
  let id = 0
  const identity = { ownerId: '小北', sessionId: 'session-1', runId: 'run-1' }
  const services = { digest: (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex'), nextId: () => `entry-${++id}` }
  const area = new MessageArea(services)
  area.append({ role: 'user', content: '合成用户问题' }, { source: 'user', persistencePolicy: 'already_persisted', persistedMessageId: '1' })
  const snapshots = new ReflectionSnapshots<unknown>(services, () => 1000)
  const projection = { ...area.identity('synthetic-model'), dynamicTailSize: 0, wire: { prefix: ['合成原生前缀'] } }
  const input: CanonicalCompletionInput = {
    identity, modelIdentity: 'synthetic-model', accessScopeHash: 'scope-1',
    request: { area, rag: { tail: [] }, stanceToPersist: null, protectedHistoryStart: null },
    projection, requestSystemPrompt: '原请求固定规则', requestTools: [{ name: '原请求工具' }],
    text: '合成最终回复', providerContextInput: 100, providerCompacted: false, hadTools: true
  }
  const notifyReady = vi.fn(async () => undefined)
  const policy = vi.fn(async () => ({ enabled: true, scope: 'owner' as const }))
  const finalizer = createReflectionFinalizer({
    snapshots, policy, notifyReady,
    projection: { append: (value, tail) => ({ ...value, wire: { prefix: value.wire, tail }, dynamicTailSize: 0 }) }
  })
  return { identity, input, snapshots, policy, notifyReady, finalizer }
}

describe('成功Run收尾接入不可变主请求反思快照', () => {
  it('原生前缀和回复只各保留一次，通知只带指纹与身份，不持久化wire', async () => {
    const f = fixture()
    await f.finalizer.complete(f.input)
    const snapshot = f.snapshots.peek(f.identity, 'synthetic-model', 'scope-1')!
    expect(snapshot.systemPrompt).toBe('原请求固定规则')
    expect(snapshot.tools).toEqual([{ name: '原请求工具' }])
    expect(stableJson(snapshot.projection.wire).match(/合成最终回复/g)).toHaveLength(1)
    expect(stableJson(snapshot.projection.wire)).toContain('合成原生前缀')
    expect(f.notifyReady).toHaveBeenCalledWith({ identity: f.identity, accessScopeHash: 'scope-1', scope: 'owner', snapshotDigest: snapshot.digest, recovery: 'reuse', hadTools: true })
    expect(stableJson(f.notifyReady.mock.calls)).not.toContain('合成原生前缀')
    expect(stableJson(f.notifyReady.mock.calls)).not.toContain('合成最终回复')
  })

  it('无回复或策略禁用时不捕获、不唤醒Job', async () => {
    const f = fixture()
    await f.finalizer.complete({ ...f.input, text: '' })
    expect(f.policy).not.toHaveBeenCalled()
    f.policy.mockResolvedValue({ enabled: false, scope: 'owner' })
    await f.finalizer.complete(f.input)
    expect(f.notifyReady).not.toHaveBeenCalled()
    expect(f.snapshots.peek(f.identity, 'synthetic-model', 'scope-1')).toBeNull()
  })

  it('普通群主请求快照缺失时延后，不静默改用数据库重建', async () => {
    const f = fixture()
    const notifyReady = vi.fn(async () => undefined)
    const finalizer = createReflectionFinalizer({
      snapshots: f.snapshots,
      policy: async () => ({ enabled: true, scope: 'group' }),
      projection: { append: (projection) => projection }, notifyReady
    })
    await finalizer.complete({ ...f.input, projection: null })
    expect(notifyReady).toHaveBeenCalledWith(expect.objectContaining({ recovery: 'defer', snapshotDigest: null }))
    expect(f.snapshots.peek(f.identity, 'synthetic-model', 'scope-1')).toBeNull()
  })
})
