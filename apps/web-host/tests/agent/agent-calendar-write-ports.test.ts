import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { createAgentToolRegistry } from '../../src/domains/agent-sessions/tools/agent-tool-registry.js'
import { createWebAgentCalendarWritePorts } from '../../src/domains/agent-sessions/tools/agent-calendar-write-ports.js'

test('Web 日历组合经注册器保存提醒并更新事件，撤权后拒绝写入', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-calendar-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const identity = { ownerId: opened.ownerId, sessionId: '7', runId: 'run-a' }
    const lease = { identity, input: { v: 2, source: 'web' }, token: 'synthetic', fence: 1 } as never
    let releases = 0, allowed = true
    const pool = { async connect() { return { async query() { return { rowCount: 1 } }, release() { releases++ } } } } as never
    const publications: unknown[] = []
    const ports = createWebAgentCalendarWritePorts({ core: runtime, pool, lease,
      delivery: { async resolveDelivery(_client, owner, input) {
        assert.equal(owner, identity.ownerId)
        assert.deepEqual(input.channels, ['qq'])
        return { qq: { platform: 'qq', chat_type: 'c2c', puid: 'synthetic' } }
      } },
      async publishCreate(event) { publications.push(event) }, async publishUpdate(event) { publications.push(event) },
    })
    const registry = createAgentToolRegistry({ core: runtime, ...ports, authorize: async (candidate, name) =>
      allowed && candidate.ownerId === identity.ownerId && ['create_event', 'update_event'].includes(name) })
    const scope = { identity, roundId: 'round-a', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('不执行 Shell') } }
    const created = await registry.tools.dispatch({ id: 'create', name: 'create_event', input: {
      title: '合成活动', date: '2099-12-01', time: '10:00', all_day: false, reminders: [{ lead_minutes: 30, channels: ['qq'] }],
    } }, scope)
    assert.equal(created.kind, 'completed')
    if (created.kind !== 'completed') throw new Error('创建未完成')
    assert.equal(created.successful, true)
    const eventId = (created.value as { event_id: number }).event_id
    const updated = await registry.tools.dispatch({ id: 'update', name: 'update_event', input: { event_id: eventId, title: '更新活动' } }, scope)
    assert.equal(updated.kind === 'completed' && updated.successful, true)
    const stored = await runtime.db.selectFrom('calendar_events').select('title').where('id', '=', eventId).executeTakeFirst()
    assert.equal(stored?.title, '更新活动')
    const reminder = await runtime.db.selectFrom('scheduled_tasks').select(['channels', 'delivery_targets']).where('event_id', '=', eventId).executeTakeFirst()
    assert.equal(reminder?.channels, 'qq')
    assert.deepEqual(JSON.parse(String(reminder?.delivery_targets)), { qq: { platform: 'qq', chat_type: 'c2c', puid: 'synthetic' } })
    assert.ok(publications.length >= 2)
    assert.equal(releases, 1)
    allowed = false
    const denied = await registry.tools.dispatch({ id: 'denied', name: 'update_event', input: { event_id: eventId, title: '不应写入' } }, scope)
    assert.equal(denied.kind === 'completed' && denied.successful, false)
    assert.equal((await runtime.db.selectFrom('calendar_events').select('title').where('id', '=', eventId).executeTakeFirst())?.title, '更新活动')
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
