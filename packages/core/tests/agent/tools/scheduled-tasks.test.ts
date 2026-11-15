import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createKyselyScheduledTaskReader, createScheduledTaskQueries } from '../../../src/scheduled-tasks/task-list.js'
import { createListScheduledTasksTool } from '../../../src/agent/tools/scheduled-tasks.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'

it('真实注册器经正式SQLite只读定时任务，隔离owner和提醒并在撤权、取消时拒绝', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-agent-scheduled-'))
  const path = join(folder, 'core.db')
  await initializeSqlite(path)
  const { runtime, ownerId } = await openSqliteRuntime(path)
  try {
    const owner = ownerId.replaceAll('-', ''), other = randomUUID()
    for (const [id, event, kind, enabled] of [[1, null, 'cron', 1], [2, 7, 'once', 1], [3, null, 'interval', 0]] as const)
      await sql`INSERT INTO scheduled_tasks(id,user_id,event_id,name,payload,cron,schedule_kind,interval_minutes,channels,enabled,delivery_targets,authorized_tools,email_attachment_file_ids,created_at,updated_at)
        VALUES(${id},${owner},${event},'合成任务','指令','0 9 * * *',${kind},10,'web,qq',${enabled},'{"qq":"private"}','["send_email"]','[5]','2026-01-01 00:00:00','2026-01-01 00:00:00')`.execute(runtime.db)
    const query = createScheduledTaskQueries(createKyselyScheduledTaskReader(runtime.db, 'sqlite'), () => ({ workspaceSupported: false, filesystemAuthorizationEnabled: false }), () => '2026-01-02T00:00:00Z')
    let authorized = true
    const registry = createToolRegistry({ tools: [createListScheduledTasksTool({ list: (identity, signal) => query.agent(identity.ownerId, signal) })], authorize: async () => authorized })
    const identity = { ownerId, sessionId: '1', runId: 'run' }
    const scope = { identity, roundId: 'round', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不可执行进程') } }
    const call = { id: 'list', name: 'list_scheduled_tasks', input: {} }
    const before = await sql`SELECT * FROM scheduled_tasks ORDER BY id`.execute(runtime.db)
    expect((await registry.capabilities(identity)).map(item => item.name)).toEqual(['list_scheduled_tasks'])
    const result = await registry.tools.dispatch(call, scope)
    expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: false, value: [
      { id: 3, name: '合成任务', when: '每 10 分钟', schedule_kind: 'interval', cron: '0 9 * * *', interval_minutes: 10, start_at: null, end_at: null, schedule_status: 'disabled', instruction: '指令', channels: ['web', 'qq'], enabled: false, last_run_at: null, delivery_targets: { qq: 'private' }, authorized_tools: ['send_email'], email_attachment_file_ids: [5], workspace_id: null, filesystem_authorized: false },
      { id: 1, when: '每天 09:00', schedule_status: 'active' },
    ] })
    expect((await registry.tools.dispatch(call, { ...scope, identity: { ...identity, ownerId: other } }))).toMatchObject({ successful: true, value: [] })
    authorized = false
    expect(await registry.tools.dispatch(call, scope)).toMatchObject({ successful: false, executed: false })
    authorized = true
    const controller = new AbortController(); controller.abort()
    await expect(registry.tools.dispatch(call, { ...scope, signal: controller.signal })).rejects.toThrow()
    expect(await sql`SELECT * FROM scheduled_tasks ORDER BY id`.execute(runtime.db)).toEqual(before)
    await sql`DROP TABLE scheduled_tasks`.execute(runtime.db)
    const failed = await registry.tools.dispatch(call, scope)
    expect(failed).toMatchObject({ successful: false, value: { error: '工具执行失败' } })
    expect(JSON.stringify(failed)).not.toContain('no such table')
  } finally { await runtime.close(); await rm(folder, { recursive: true, force: true }) }
})
