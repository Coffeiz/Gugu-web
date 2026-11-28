import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import { databaseTime } from '../../src/data/codec.js'
import { tablesSql } from '../../src/data/schema.js'
import { createKyselyScheduledTaskReader, createScheduledTaskQueries, projectScheduledTaskForAgent } from '../../src/tasks/task-list.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
describe.each(['sqlite', 'postgres'] as const)('定时任务列表 %s', backend => {
  it.skipIf(backend === 'postgres' && !url)('保持 owner、事件范围、精确时间及可信能力', async () => {
    const schema = `task_list_${randomUUID().replaceAll('-', '')}`
    const admin = backend === 'postgres' ? new Pool({ connectionString: url }) : undefined
    if (admin) await admin.query(`CREATE SCHEMA "${schema}"`)
    const folder = backend === 'sqlite' ? await mkdtemp(join(tmpdir(), 'gugu-task-list-')) : undefined
    const path = folder && join(folder, 'core.db')
    if (path) await initializeSqlite(path)
    const opened = path ? await openSqliteRuntime(path) : undefined
    const db = opened?.runtime.db ?? new Kysely<{}>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, options: `-c search_path=${schema}` }) }) })
    try {
      if (backend === 'postgres') {
        await sql.raw(tablesSql('postgres').scheduledTasks).execute(db)
        await sql`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'instruction'`.execute(db)
      }
      const owner = opened?.ownerId ?? randomUUID(), other = randomUUID()
      const stored = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
      const time = databaseTime('2026-01-01T12:34:56.123456Z', backend)
      const bool = (value: boolean) => backend === 'sqlite' ? Number(value) : value
      for (const [id, event, enabled, kind] of [[1, null, true, 'cron'], [2, 7, true, 'once'], [3, null, false, 'interval']] as const)
        await sql`INSERT INTO scheduled_tasks(id,user_id,event_id,name,payload,cron,schedule_kind,interval_minutes,start_at,end_at,channels,enabled,delivery_targets,authorized_tools,email_attachment_file_paths,last_run_at,created_at,updated_at)
          VALUES(${id},${stored},${event},'合成任务','内容','0 9 * * *',${kind},10,${time},${time},'web,qq',${bool(enabled)},'{"qq":"private"}','["send_email"]','[5]',${time},${time},${time})`.execute(db)
      if (backend === 'postgres') await sql`INSERT INTO scheduled_tasks(id,user_id,name,payload,cron,schedule_kind,channels,enabled,created_at,updated_at) VALUES(4,${other},'其他','','*','cron','web',TRUE,${time},${time})`.execute(db)
      const read = createKyselyScheduledTaskReader(db, backend)
      const query = createScheduledTaskQueries(read, () => ({ workspaceSupported: false, filesystemAuthorizationEnabled: false }), () => '2026-01-02T00:00:00Z')
      const agent = await query.agent(owner)
      expect(agent.map(task => task.id)).toEqual([3, 1])
      expect(agent[0]).toMatchObject({ when: '每 10 分钟', schedule_status: 'ended', start_at: '2026-01-01T12:34:56.123456Z', last_run_at: '2026-01-01T12:34:56.123456+00:00', workspace_id: null, filesystem_authorized: false, authorized_tools: ['send_email'] })
      expect(agent[1]).toMatchObject({ when: '每天 09:00', channels: ['web', 'qq'] })
      const row = (await read(owner, null))[1]!
      const caps = { workspaceSupported: false, filesystemAuthorizationEnabled: false }
      expect(projectScheduledTaskForAgent({ ...row, cron: '٥ ٩ * * *' }, caps).when).toBe('每天 09:05')
      expect(projectScheduledTaskForAgent({ ...row, cron: '0 9 ² * *' }, caps).when).toBe('每月²号 09:00')
      expect(() => projectScheduledTaskForAgent({ ...row, cron: '² 9 * * *' }, caps)).toThrow()
      expect(projectScheduledTaskForAgent(row, caps, () => '2026-01-01T12:34:56.123455Z').schedule_status).toBe('active')
      expect(projectScheduledTaskForAgent(row, caps, () => '2026-01-01T12:34:56.123456Z').schedule_status).toBe('ended')
      expect((await query.web(owner, 7)).tasks.map(task => task.id)).toEqual([2])
      expect((await query.agent(other)).map(task => task.id)).toEqual(backend === 'postgres' ? [4] : [])
      const controller = new AbortController(); controller.abort()
      await expect(query.agent(owner, controller.signal)).rejects.toThrow()
      expect((await sql`SELECT id FROM scheduled_tasks`.execute(db)).rows).toHaveLength(backend === 'postgres' ? 4 : 3)
      if (backend === 'sqlite') {
        await sql`INSERT INTO scheduled_tasks(id,user_id,name,payload,cron,schedule_kind,channels,enabled,created_at,updated_at)
          VALUES(9007199254740993,${stored},'溢出','','*','cron','web',1,${time},${time})`.execute(db)
        await expect(query.agent(owner)).rejects.toThrow()
        await sql`DELETE FROM scheduled_tasks WHERE id=9007199254740993`.execute(db)
      }
      if (backend === 'postgres') {
        await sql`UPDATE scheduled_tasks SET workspace_id=12,filesystem_authorization_grant_id=13 WHERE id=1`.execute(db)
        const enabled = createScheduledTaskQueries(read, () => ({ workspaceSupported: true, filesystemAuthorizationEnabled: true }))
        expect((await enabled.agent(owner)).find(task => task.id === 1)).toMatchObject({ workspace_id: 12, filesystem_authorized: true })
        expect((await query.agent(owner)).find(task => task.id === 1)).toMatchObject({ workspace_id: null, filesystem_authorized: false })
      }
    } finally {
      if (opened) await opened.runtime.close(); else await db.destroy()
      if (folder) await rm(folder, { recursive: true, force: true })
      if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
    }
  })
})
