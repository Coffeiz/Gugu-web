import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { formatAgentProjects } from '@gugu/core/agent'
import { createAgentOverviewSources } from '../../../src/modules/agent/context/overview.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('上下文概览限定 owner、保留时区日期、项目排序及个人文件边界', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `agent_overview_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE conversation_sessions(id int,user_id uuid); CREATE TABLE projects(id int,user_id uuid,name text,status text,priority text,start_date text,deadline text,done_at timestamptz,contact_name text,summary text,stages_json text,archived bool,deleted_at timestamptz); CREATE TABLE folders(id int,user_id uuid,project_id int,workspace_directory_id int,parent_id int,name text,deleted_at timestamptz); CREATE TABLE files(id int,user_id uuid,space text,project_id int,folder_id int,display_name text,ext text,updated_at timestamptz,deleted_at timestamptz); CREATE TABLE calendar_events(id int,user_id uuid,date text,title text,deleted_at timestamptz); CREATE TABLE mind_nodes(id int,user_id uuid,kind text,title text,content_plain text,content_md text,captured_at timestamptz,deleted_at timestamptz)`)
    const owner = randomUUID(), other = randomUUID()
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1),(2,$2)', [owner,other])
    await pool.query(`INSERT INTO projects VALUES (1,$1,'甲','active','high',NULL,'2026-01-03',NULL,'小北','  项目  摘要  ','[{"done":true}]',false,NULL),(2,$2,'不应看到','active','high',NULL,NULL,NULL,NULL,NULL,'[]',false,NULL)`, [owner,other])
    await pool.query(`INSERT INTO folders VALUES (1,$1,1,NULL,NULL,'项目根',NULL),(2,$1,NULL,NULL,NULL,'个人根',NULL)`, [owner])
    await pool.query(`INSERT INTO files VALUES (1,$1,'project',1,NULL,'项目','md',now(),NULL),(2,$1,'personal',NULL,2,'个人','txt',now(),NULL),(3,$2,'personal',NULL,NULL,'私有','txt',now(),NULL)`, [owner,other])
    await pool.query(`INSERT INTO calendar_events VALUES (1,$1,'2026-01-01','昨天',NULL),(2,$1,'2026-01-02','今天',NULL),(3,$2,'2026-01-02','私有',NULL)`, [owner,other])
    await pool.query(`INSERT INTO mind_nodes VALUES (1,$1,'note','记录','正文',NULL,'2026-01-01',NULL),(2,$1,'canvas_note','画布','正文',NULL,'2026-01-01',NULL)`, [owner])
    const sources = createAgentOverviewSources(pool, () => new Date('2026-01-01T16:30:00Z')), identity = { ownerId: owner, sessionId: '1' }
    const projects = await sources.loadProjects(identity), formatted = formatAgentProjects(projects)
    assert.match(formatted, /甲（1\/1阶段，截止 2026-01-03，联系人：小北，根层文件夹：项目根）/)
    assert.match(formatted, /共 1 个文件，根层 1 个，目录 1 个/); assert.doesNotMatch(formatted, /不应看到/)
    assert.deepEqual(await sources.loadEvents(identity, 'Asia/Shanghai'), [{ date:'2026-01-02', title:'今天' }])
    assert.equal((await sources.loadNotes(identity) as unknown[]).length, 1)
    const files = await sources.loadFilesOverview(identity) as { total: number; files: { name: string }[] }
    assert.equal(files.total, 1); assert.deepEqual(files.files.map(file => file.name), ['个人.txt'])
    await assert.rejects(sources.loadProjects({ ownerId: other, sessionId: '1' }), /会话不存在/)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
