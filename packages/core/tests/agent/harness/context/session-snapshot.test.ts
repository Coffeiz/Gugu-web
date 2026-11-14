import { createHash } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import type { Json,SessionSnapshotPorts,SessionSnapshotState } from "../../../../src/agent/harness/index.js"
import {
DEFAULT_IDLE_TTL_MS,SNAPSHOT_CONTEXT_VERSION,ensureSessionSnapshot,invalidateSessionSnapshot,readSessionSnapshot,
sessionSnapshotHash,snapshotHistoryBaseline,snapshotIsUsable,snapshotMessageHash,stableJson,updateBaselineSnapshot,workspaceBindingKey
} from "../../../../src/agent/harness/index.js"
const identity = { ownerId: 'owner', sessionId: 'session' }
function state(): SessionSnapshotState {
  return { ...identity, context: null, contextEpoch: 0, snapshotHash: null, sessionInfoHash: null, snapshotExpiresAt: null, baselineMessageSeq: 0 }
}
function ports(): SessionSnapshotPorts & { advance(ms: number): void; loaded(): number; revisions(): number } {
  let now = 0, loads = 0, revisions = 0
  return {
    digest: value => createHash('sha256').update(stableJson(value)).digest('hex'), nextId: () => 'unused', now: () => now,
    advance: ms => { now += ms }, loaded: () => loads, revisions: () => revisions,
    currentRevision: async () => { revisions++; return 7 }, loadContext: async () => { loads++; return { systemPrompt: '固定人格', snapshotContext: `业务快照${loads}`, sessionInfo: { version: loads }, userTimezone: 'Asia/Shanghai' } }
  }
}
describe('会话快照事务候选与生命周期', () => {
  it('session_info键插入顺序不同但语义相同时快照hash一致', async () => {
    const firstPort = ports(), secondPort = ports()
    firstPort.loadContext = async () => ({ systemPrompt: '人格', snapshotContext: '快照', sessionInfo: { a: 1, nested: { b: 2, c: 3 } }, userTimezone: 'LOCAL' })
    secondPort.loadContext = async () => ({ systemPrompt: '人格', snapshotContext: '快照', sessionInfo: { nested: { c: 3, b: 2 }, a: 1 }, userTimezone: 'LOCAL' })
    const first = await ensureSessionSnapshot(identity, state(), firstPort), second = await ensureSessionSnapshot(identity, state(), secondPort)
    expect(first.state.sessionInfoHash).toBe(second.state.sessionInfoHash); expect(first.state.snapshotHash).toBe(second.state.snapshotHash)
  })
  it('首次epoch为1，只load一次，命中滑动TTL并保持原state不可变', async () => {
    const port = ports(), original = state()
    const first = await ensureSessionSnapshot(identity, original, port)
    expect(first.expectedEpoch).toBe(0); expect(first.state.contextEpoch).toBe(1); expect(first.phase).toBe('rebuild')
    expect(first.state.snapshotExpiresAt).toBe(DEFAULT_IDLE_TTL_MS)
    expect(original).toEqual(state())
    port.advance(DEFAULT_IDLE_TTL_MS - 1)
    const second = await ensureSessionSnapshot(identity, first.state, port)
    expect(second.phase).toBe('hit'); expect(second.state.contextEpoch).toBe(1); expect(port.loaded()).toBe(1)
    expect(second.state.snapshotExpiresAt).toBe(2 * DEFAULT_IDLE_TTL_MS - 1)
    expect(port.revisions()).toBe(1)
  })
  it('TTL恰到边界重建，过期之前可用', async () => {
    const port = ports(), first = await ensureSessionSnapshot(identity, state(), port)
    expect(snapshotIsUsable(first.state, { now: DEFAULT_IDLE_TTL_MS - 1 })).toBe(true)
    expect(snapshotIsUsable(first.state, { now: DEFAULT_IDLE_TTL_MS })).toBe(false)
    port.advance(DEFAULT_IDLE_TTL_MS)
    const second = await ensureSessionSnapshot(identity, first.state, port)
    expect(second.phase).toBe('rebuild'); expect(second.state.contextEpoch).toBe(2)
    expect(port.loaded()).toBe(2)
  })
  it('业务revision仅待吸收元数据，命中不读revision或重建', async () => {
    const port = ports(), first = await ensureSessionSnapshot(identity, state(), port)
    first.state.context!.context_revision = 100
    const second = await ensureSessionSnapshot(identity, first.state, port)
    expect(second.phase).toBe('hit'); expect(port.loaded()).toBe(1); expect(port.revisions()).toBe(1)
  })
  it.each(['snapshot_context_version', 'system_prompt', 'session_info'] as const)('旧快照缺失%s强制重建', async field => {
    const port = ports(), first = await ensureSessionSnapshot(identity, state(), port)
    delete first.state.context![field]
    expect((await ensureSessionSnapshot(identity, first.state, port)).phase).toBe('rebuild')
  })
  it('locale或绑定的稳定字段变化重建，额外运行时字段变化不破坏命中', async () => {
    const port = ports(), binding = { workspace_id: 1, space: 'personal', folder_id: 2, runtime_secret: 'not-in-key' }
    const first = await ensureSessionSnapshot(identity, state(), port, { workspaceBinding: binding, locale: 'zh-CN' })
    expect((await ensureSessionSnapshot(identity, first.state, port, { workspaceBinding: { ...binding, runtime_secret: 'changed' }, locale: 'zh-CN' })).phase).toBe('hit')
    expect((await ensureSessionSnapshot(identity, first.state, port, { workspaceBinding: { ...binding, folder_id: 3 } })).phase).toBe('rebuild')
    expect((await ensureSessionSnapshot(identity, first.state, port, { locale: 'en-US' })).phase).toBe('rebuild')
    expect(workspaceBindingKey(binding)).not.toHaveProperty('runtime_secret')
  })
  it('重建保留会话goal、姿态去重、Skill和Provider锚点，丢弃过期业务快照字段', async () => {
    const port = ports(), original = state()
    const control: Record<string, Json> = {
      goal_text: '合成目标', goal_status: 'active', goal_mode: 'auto', stance_digest: 'stance',
      user_skill_snapshot: ['skill'], provider_cache_anchor: { digest: 'anchor' }
    }
    original.context = { ...control, stale_business: 'old' }; original.contextEpoch = 8
    const rebuilt = await ensureSessionSnapshot(identity, original, port)
    expect(rebuilt.state.context).toMatchObject(control); expect(rebuilt.state.context).not.toHaveProperty('stale_business')
    expect(rebuilt.state.contextEpoch).toBe(9); expect(rebuilt.expectedEpoch).toBe(8)
  })
  it('显式invalidate保留正文/hash和session info，只推进epoch并过期', async () => {
    const port = ports(), first = await ensureSessionSnapshot(identity, state(), port)
    const invalid = invalidateSessionSnapshot(first.state, 100)
    expect(invalid.context).toEqual(first.state.context); expect(invalid.snapshotHash).toBe(first.state.snapshotHash)
    expect(invalid.sessionInfoHash).toBe(first.state.sessionInfoHash); expect(invalid.contextEpoch).toBe(2)
    expect(snapshotIsUsable(invalid, { now: 100 })).toBe(false)
  })
  it('baseline更新只改水位/revision/epoch/hash，冻结snapshot正文和控制状态保留', async () => {
    const port = ports(), first = await ensureSessionSnapshot(identity, state(), port)
    first.state.context!.goal_text = '合成目标'
    const updated = updateBaselineSnapshot(first.state, [{ role: 'user', content: '已摘要历史' }], port, { baselineMessageSeq: 11 })
    expect(updated.context!.snapshot_context).toBe(first.state.context!.snapshot_context)
    expect(updated.context!.goal_text).toBe('合成目标'); expect(updated.context!.rag_revision).toBe('8')
    expect(snapshotHistoryBaseline(updated)).toBe(11); expect(updated.contextEpoch).toBe(2)
    expect(updated.snapshotHash).not.toBe(first.state.snapshotHash)
  })
  it('snapshot和baseline分别存水位时取较大值，legacy零revision仍是合法RAG版本', () => {
    const original = state(); original.baselineMessageSeq = 8
    original.context = { history_baseline_message_seq: 10, context_revision: 0, dynamic_context: '旧命名快照' }
    expect(snapshotHistoryBaseline(original)).toBe(10)
    expect(readSessionSnapshot(original).ragRevision).toBe('0')
    expect(readSessionSnapshot(original).snapshotContext).toBe('旧命名快照')
    original.context.history_baseline_message_seq = 6
    expect(snapshotHistoryBaseline(original)).toBe(8)
  })
  it('message hash排除trace元数据，四个snapshot身份成分都参与hash', () => {
    const port = ports()
    expect(snapshotMessageHash([{ role: 'user', content: '正文', trace_id: 'a' }], port)).toBe(snapshotMessageHash([{ role: 'user', content: '正文', trace_id: 'b' }], port))
    const base = sessionSnapshotHash('s', 'i', 'm', 'c', port)
    for (let index = 0;index < 4;index++) {
      const values: [string, string, string, string] = ['s', 'i', 'm', 'c']; values[index] = 'different'
      expect(sessionSnapshotHash(...values, port)).not.toBe(base)
    }
  })
  it('跨owner快照不触发任何上下文读取，load失败不修改原始状态', async () => {
    const port = ports(), original = state()
    await expect(ensureSessionSnapshot({ ...identity, ownerId: 'foreign' }, original, port)).rejects.toThrow('归属')
    expect(port.loaded()).toBe(0)
    port.loadContext = async () => { throw new Error('合成读取失败') }
    await expect(ensureSessionSnapshot(identity, original, port)).rejects.toThrow('合成读取失败')
    expect(original.context).toBeNull(); expect(original.contextEpoch).toBe(0)
  })
  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5])('非法epoch %s不能生成Data CAS候选且不读取上下文', async epoch => {
    const port = ports(), original = state(); original.contextEpoch = epoch
    await expect(ensureSessionSnapshot(identity, original, port)).rejects.toThrow('epoch')
    expect(port.loaded()).toBe(0); expect(port.revisions()).toBe(0)
  })
  it('baseline更新拒绝小于旧session/context任一水位的候选，重建保留较大旧水位', async () => {
    const port = ports(), original = state(); original.baselineMessageSeq = 8; original.context = { history_baseline_message_seq: 10 }
    expect(() => updateBaselineSnapshot(original, [], port, { baselineMessageSeq: 6 })).toThrow('不得回退')
    const rebuilt = await ensureSessionSnapshot(identity, original, port)
    expect(rebuilt.state.context!.history_baseline_message_seq).toBe(10)
  })
  it('版本常量与当前Python规则相同，不把变更后的业务revision混成格式版本', () => {
    expect(SNAPSHOT_CONTEXT_VERSION).toBe(3); expect(DEFAULT_IDLE_TTL_MS).toBe(1_800_000)
  })
})
