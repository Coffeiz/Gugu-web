import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createGlobalSearchOperations } from '../../../src/search/global-search.js'
import { createKyselySqliteGlobalSearchSources } from '../../../src/search/sqlite.js'
import { parseGlobalSearchQuery } from '../../../src/search/query.js'

it('正式 SQLite 搜索便签、画布便签和启用中的定时任务并隔离 owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-global-search-sqlite-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const owner = ownerId.replaceAll('-', ''), other = randomUUID().replaceAll('-', '')
      const stamp = '2026-01-01 00:00:00.000000'
      await sql`INSERT INTO mind_nodes(id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at,deleted_at)
        VALUES (1,${owner},'note','检索标题','正文含有目标词','正文含有目标词','user',1,${stamp},${stamp},${stamp},NULL),
          (2,${other},'note','其他账号目标词','不应命中','不应命中','user',1,${stamp},${stamp},${stamp},NULL),
          (3,${owner},'note','已删除目标词','墓碑','墓碑','user',1,${stamp},${stamp},${stamp},${stamp})`.execute(runtime.db)
      await sql`INSERT INTO mind_maps(id,user_id,title,data_json,created_at,updated_at,deleted_at)
        VALUES (1,${owner},'画布','{}',${stamp},${stamp},NULL)`.execute(runtime.db)
      await sql`INSERT INTO mind_nodes(id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at,deleted_at)
        VALUES (4,${owner},'canvas_note','画布目标词','画布目标词','画布正文目标词','user',1,${stamp},${stamp},${stamp},NULL),
          (5,${other},'canvas_note','其他账号目标词','不应命中','不应命中','user',1,${stamp},${stamp},${stamp},NULL)`.execute(runtime.db)
      await sql`INSERT INTO mind_canvas_items(id,user_id,canvas_id,node_id,x,y,z,collapsed,data_json,created_at,updated_at,deleted_at)
        VALUES (1,${owner},1,4,0,0,1,0,'{}',${stamp},${stamp},NULL),
          (2,${other},1,5,0,0,1,0,'{}',${stamp},${stamp},NULL)`.execute(runtime.db)
      await sql`INSERT INTO scheduled_tasks(id,user_id,name,payload,cron,schedule_kind,channels,enabled,end_at,created_at,updated_at)
        VALUES (1,${owner},'目标词任务','{}','0 0 * * *','cron','web',1,NULL,${stamp},${stamp}),
          (2,${other},'其他账号目标词','{}','0 0 * * *','cron','web',1,NULL,${stamp},${stamp}),
          (3,${owner},'已停用目标词','{}','0 0 * * *','cron','web',0,NULL,${stamp},${stamp}),
          (4,${owner},'已结束目标词','{}','0 0 * * *','cron','web',1,${stamp},${stamp},${stamp})`.execute(runtime.db)
      await sql`INSERT INTO user_mcp_servers(id,user_id,scope,name,transport,endpoint,encrypted_headers,enabled,created_at,updated_at)
        VALUES ('private-server',${owner},'user','目标词私有服务','http','https://private.invalid','secret-private',1,${stamp},${stamp}),
          ('platform-server',${owner},'platform','目标词平台服务','stdio','/workspace/server.js','secret-platform',0,${stamp},${stamp}),
          ('hidden-server',${owner},'user','不应匹配','http','https://hidden.invalid','secret-hidden',1,${stamp},${stamp})`.execute(runtime.db)

      const operations = createGlobalSearchOperations(createKyselySqliteGlobalSearchSources(runtime.db))
      expect(operations.availableTypes).toEqual(['project', 'event', 'client', 'mcp', 'scheduled_task', 'note', 'canvas_note'])
      const note = await operations.search(ownerId, parseGlobalSearchQuery({ q: '目标词', types: ['note'] })) as {groups: Array<{items: Array<Record<string, unknown>>}>}
      expect(note.groups[0]?.items).toEqual([{ id: 1, title: '检索标题', subtitle: '正文含有目标词', version: 1 }])
      const canvas = await operations.search(ownerId, parseGlobalSearchQuery({ q: '目标词', types: ['canvas_note'] })) as {groups: Array<{items: Array<Record<string, unknown>>}>}
      expect(canvas.groups[0]?.items).toEqual([{ id: 4, title: '画布目标词', subtitle: '画布正文目标词', canvas_id: 1 }])
      const tasks = await operations.search(ownerId, parseGlobalSearchQuery({ q: '目标词', types: ['scheduled_task'] })) as {groups: Array<{items: Array<Record<string, unknown>>}>}
      expect(tasks.groups[0]?.items).toEqual([{ id: 1, title: '目标词任务', subtitle: 'cron · 0 0 * * *' }])
      const mcp = await operations.search(ownerId, parseGlobalSearchQuery({ q: '目标词', types: ['mcp'] })) as {groups: Array<{items: Array<Record<string, unknown>>}>}
      expect(mcp.groups[0]?.items).toEqual([
        { id: 'platform-server', title: '目标词平台服务', subtitle: 'stdio · 已停用', enabled: false },
        { id: 'private-server', title: '目标词私有服务', subtitle: 'http · 已启用', enabled: true },
      ])
      expect(JSON.stringify(mcp)).not.toMatch(/private\.invalid|workspace\/server|secret-/)
    } finally { await runtime.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
