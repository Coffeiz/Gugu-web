import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createSessionFilesystemGrant } from '../../../src/agent/interactions/grant-filesystem.js'

const ownerId = '00000000-0000-4000-8000-000000000001'

function fixture(enabled = true) {
  const state = { session: true, active: false, grants: 0, events: 0 }
  const store = { async transaction<T>(run: (tx: any) => Promise<T>) {
    const tx = {
      async lockOwnedSession(owner: string, id: number) { return owner === ownerId && id === 7 && state.session },
      async hasActiveGrant() { return state.active },
      async insertGrant(_owner: string, _id: number, _source: string, at: Date) {
        assert.ok(at instanceof Date)
        state.grants++
        return 21
      },
      async recordGrant(_owner: string, _id: number, grantId: number) { assert.equal(grantId, 21); state.events++ },
    }
    return run(tx)
  } }
  return { state, grant: createSessionFilesystemGrant({ store, enabled: () => enabled, now: () => new Date('2026-11-18T00:00:00Z') }) }
}

test('按 owner 锁定会话、授予完整用户沙箱并写审计', async () => {
  const { state, grant } = fixture()
  assert.deepEqual(await grant({ ownerId, sessionId: 7, grantedBy: 'askuser' }), { status: 'confirmed', text: '已授权当前会话完整读写用户沙箱（workspace、personal、project）。' })
  assert.equal(state.grants, 1)
  assert.equal(state.events, 1)
})

test('拒绝跨 owner 或关闭的授权能力，已存在授权时幂等返回', async () => {
  const first = fixture()
  await assert.rejects(first.grant({ ownerId: '00000000-0000-4000-8000-000000000099', sessionId: 7, grantedBy: 'user' }), { code: 'not_found' })
  assert.equal(first.state.grants, 0)
  const disabled = fixture(false)
  await assert.rejects(disabled.grant({ ownerId, sessionId: 7, grantedBy: 'user' }), { code: 'conflict' })
  const active = fixture()
  active.state.active = true
  await active.grant({ ownerId, sessionId: 7, grantedBy: 'user' })
  assert.equal(active.state.grants, 0)
  assert.equal(active.state.events, 0)
})
