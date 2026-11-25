import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { migratePostgres } from '@gugu/database/postgres'
import { initialize } from '@gugu/database/postgres/migrations/0001_initialize'
import { webDomain } from '@gugu/database/postgres/migrations/0002_web_domain'
import { runPostgresMigrations } from '../../../../packages/database/src/postgres/runner.js'
import { assertImHostSchema } from '../../src/modules/im/gateway/host-settings.js'
import { checkDatabaseReadiness } from '../../src/database.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('空库统一迁移只读检查、整体回滚、串行落库并拒绝结构漂移', {
  skip: !url && '需要隔离 PostgreSQL',
}, async () => {
  const schema = `migrations_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const state = async () => (await pool.query(`SELECT to_regclass('users') AS users,
      to_regclass('gugu_schema_migrations') AS ledger`)).rows[0]
    assert.equal(await migratePostgres(pool, 'check'), 'pending')
    assert.deepEqual(await state(), { users: null, ledger: null })

    await pool.query("CREATE TABLE knowledge_index_entries(value text); INSERT INTO knowledge_index_entries VALUES ('保留')")
    await assert.rejects(migratePostgres(pool, 'apply'), { code: 'incompatible', revision: '0011_rag_index' })
    assert.deepEqual(await state(), { users: null, ledger: null })
    assert.equal((await pool.query('SELECT value FROM knowledge_index_entries')).rows[0].value, '保留')
    await pool.query('DROP TABLE knowledge_index_entries')

    const concurrent = await Promise.all([migratePostgres(pool, 'apply'), migratePostgres(pool, 'apply')])
    assert.deepEqual(concurrent.sort(), ['applied', 'unchanged'])
    assert.equal(await migratePostgres(pool, 'check'), 'applied')
    const removedSchema = await pool.query<{ folders: string | null; fileId: boolean; filePath: boolean; fileStorageKey: boolean; fileFolderId: boolean; workspaceFolderId: boolean; storageLimit: boolean }>(`
      SELECT to_regclass('folders')::text AS folders,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='files' AND column_name='id') AS "fileId",
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='files' AND column_name='path') AS "filePath",
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='files' AND column_name='storage_key') AS "fileStorageKey",
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='files' AND column_name='folder_id') AS "fileFolderId",
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='workspaces' AND column_name='folder_id') AS "workspaceFolderId",
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='storage_limit_bytes') AS "storageLimit"
    `)
    assert.deepEqual(removedSchema.rows[0], {
      folders: null, fileId: false, filePath: true, fileStorageKey: false, fileFolderId: false, workspaceFolderId: false, storageLimit: true,
    })
    assert.deepEqual((await pool.query(`SELECT a.attname AS column_name
      FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
      WHERE i.indrelid='files'::regclass AND i.indisprimary ORDER BY array_position(i.indkey,a.attnum)`)).rows,
    [{ column_name: 'user_id' }, { column_name: 'path' }])
    const retainedQuotas = await pool.query<{ tokenLimits: boolean; searchLimit: boolean; tokenWindow: boolean }>(`
      SELECT
        (SELECT count(*)=3 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users'
          AND column_name IN ('token_limit_monthly','token_limit_6h','token_limit_weekly')) AS "tokenLimits",
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='search_limit_daily') AS "searchLimit",
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='quota_window_started_at') AS "tokenWindow"
    `)
    assert.deepEqual(retainedQuotas.rows[0], { tokenLimits: true, searchLimit: true, tokenWindow: true })
    const restoredQuotaTables = await pool.query<{ ledgers: string | null; events: string | null }>(`
      SELECT to_regclass('storage_quota_ledgers')::text AS ledgers, to_regclass('storage_quota_events')::text AS events
    `)
    assert.deepEqual(restoredQuotaTables.rows[0], { ledgers: 'storage_quota_ledgers', events: 'storage_quota_events' })
    const owner = randomUUID()
    await pool.query('INSERT INTO users(id,username,email,hashed_password) VALUES ($1,$2,$3,$4)',
      [owner, `path-${owner}`, `${owner}@example.invalid`, 'synthetic'])
    const { rows: [project] } = await pool.query<{ id: number }>(
      `INSERT INTO projects(user_id,name,status,start_date,color,progress,stages_json,version,archived,created_at,updated_at)
       VALUES ($1,'路径项目','active','2026-11-01','#000000',0,'[]',1,false,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING id`, [owner],
    )
    await pool.query(`INSERT INTO files(user_id,display_name,ext,space,project_id,path)
      VALUES ($1,'嵌套文件','txt','project',$2,$3)`, [owner, project!.id, `${owner}/项目文件/2026/11/路径项目 #${project!.id}/目录/文件.txt`])
    assert.equal((await pool.query<{ file_count: string }>(
      'SELECT file_count FROM project_file_counts WHERE project_id=$1', [project!.id],
    )).rows[0]?.file_count, '1')
    await pool.query('UPDATE files SET deleted_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND project_id=$2', [owner, project!.id])
    assert.equal((await pool.query('SELECT 1 FROM project_file_counts WHERE project_id=$1', [project!.id])).rowCount, 0)
    await checkDatabaseReadiness(statement => pool.query(statement))
    await assertImHostSchema(pool)
    const jobs = await pool.query('SELECT mode, status, updated_at FROM data_import_jobs')
    assert.equal(jobs.rowCount, 0)
    assert.ok((await pool.query("SELECT to_regclass('project_undo_journals') AS journal")).rows[0].journal)

    const revision = '0004_agent_snapshots'
    const { rows: [entry] } = await pool.query('SELECT checksum FROM gugu_schema_migrations WHERE revision=$1', [revision])
    await pool.query("UPDATE gugu_schema_migrations SET checksum='伪造' WHERE revision=$1", [revision])
    await assert.rejects(migratePostgres(pool, 'check'), { code: 'incompatible', revision })
    await pool.query('UPDATE gugu_schema_migrations SET checksum=$1 WHERE revision=$2', [entry.checksum, revision])

    await pool.query('ALTER TABLE scheduled_tasks DROP CONSTRAINT scheduled_tasks_execution_mode_check')
    await assert.rejects(migratePostgres(pool, 'check'), { code: 'incompatible', revision: '0022_scheduled_task_mode' })
    await pool.query("ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_execution_mode_check CHECK (execution_mode IN ('reminder', 'instruction'))")
    assert.equal(await migratePostgres(pool, 'check'), 'applied')

    await pool.query('ALTER TABLE files DISABLE TRIGGER gugu_project_file_count_insert')
    await assert.rejects(migratePostgres(pool, 'check'), { code: 'incompatible', revision: '0002_web_domain' })
    await assert.rejects(migratePostgres(pool, 'apply'), { code: 'incompatible', revision: '0002_web_domain' })
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end() }
  }
})

test('已有旧文件夹结构的迁移库可先通过旧版本校验，再升级并删除旧表', {
  skip: !url && '需要隔离 PostgreSQL',
}, async () => {
  const schema = `folder_upgrade_${randomUUID().replaceAll('-', '')}`
  const storageRoot = await mkdtemp(join(tmpdir(), 'gugu-file-path-upgrade-'))
  const admin = new Pool({ connectionString: url })
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    assert.equal(await runPostgresMigrations(pool, 'apply', [initialize, webDomain]), 'applied')
    const owner = randomUUID()
    await pool.query('INSERT INTO users(id,username,email,hashed_password) VALUES ($1,$2,$3,$4)',
      [owner, `folder-upgrade-${owner}`, `${owner}@example.invalid`, 'synthetic'])
    const { rows: [project] } = await pool.query<{ id: number }>(
      `INSERT INTO projects(user_id,name,status,start_date,color,progress,stages_json,version,archived,created_at,updated_at)
       VALUES ($1,'升级项目','active','2026-11-01','#000000',0,'[]',1,false,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING id`, [owner],
    )
    const { rows: [folder] } = await pool.query<{ id: number }>(
      `INSERT INTO folders(user_id,name,project_id) VALUES ($1,'旧目录',$2) RETURNING id`, [owner, project!.id],
    )
    const storageKey = `${owner}/项目文件/2026/11/升级项目 #${project!.id}/旧目录/保留.txt`
    const { rows: [legacyFile] } = await pool.query<{ id: number }>(`INSERT INTO files(user_id,display_name,ext,space,project_id,folder_id,storage_key)
      VALUES ($1,'保留.txt','txt','project',$2,$3,$4) RETURNING id`, [owner, project!.id, folder!.id, storageKey])
    await mkdir(dirname(join(storageRoot, storageKey)), { recursive: true })
    await writeFile(join(storageRoot, storageKey), '旧文件正文')
    let legacyMindRefId: number | null = null, legacyMindTextId: number | null = null
    if (process.platform === 'linux') {
      const { rows: [legacyMindRef] } = await pool.query<{ id: number }>(`INSERT INTO mind_nodes(
        user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at,ref_type,ref_id)
        VALUES ($1,'ref','保留.txt','','','user',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'file',$2) RETURNING id`,
      [owner, legacyFile!.id])
      const { rows: [legacyMindText] } = await pool.query<{ id: number }>(`INSERT INTO mind_nodes(
        user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at)
        VALUES ($1,'note','路径链接',$2,$2,'user',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING id`,
      [owner, `[文件](gugu://open-object/file/${legacyFile!.id})`])
      legacyMindRefId = legacyMindRef!.id
      legacyMindTextId = legacyMindText!.id
    }
    assert.equal(await readFile(join(storageRoot, storageKey), 'utf8'), '旧文件正文')
    const { rows: [session] } = await pool.query<{ id: number }>(
      'INSERT INTO conversation_sessions(user_id,title) VALUES ($1,$2) RETURNING id', [owner, '路径迁移夹具'],
    )
    await pool.query(`INSERT INTO conversation_messages(session_id,conversation_seq,role,content,files)
      VALUES ($1,1,'assistant',$3, $2::jsonb)`, [session!.id, JSON.stringify([
      { file_id: legacyFile!.id, name: '保留.txt' }, { attach_id: 'a'.repeat(32), name: '临时附件.txt' },
    ]), process.platform === 'linux' ? `[[file:${legacyFile!.id}|文件]]` : ''])
    const { rows: [legacyTask] } = await pool.query<{ id: number }>(`INSERT INTO scheduled_tasks(
      user_id,name,payload,cron,channels,enabled,email_attachment_file_ids,created_at,updated_at)
      VALUES ($1,'旧附件任务','{}','0 * * * *','desktop',true,$2::json,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING id`,
    [owner, JSON.stringify([String(legacyFile!.id)])])
    const { rows: [undoJournal] } = await pool.query<{ id: string }>(`INSERT INTO project_undo_journals(
      id,user_id,operation_id,before_status,after_status,moves,created_at)
      VALUES ($1,$2,'旧文件撤销','active','undone',$3::json,CURRENT_TIMESTAMP) RETURNING id`,
    [randomUUID(), owner, JSON.stringify([{ fileId: legacyFile!.id, kind: 'file', from: storageKey, to: `${storageKey}.trash` }, { projectId: project!.id }])])
    const { rows: [legacyUndo] } = await pool.query<{ id: string }>(`INSERT INTO undo_operations(
      id,user_id,undo_context_id,group_id,resource,action,target_refs,before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at,expires_at)
      VALUES ($1,$2,'迁移夹具',$1,'projects','delete',$3::json,$4::json,$5::json,$6::json,'{}','web','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '1 day') RETURNING id`,
    [randomUUID(), owner, JSON.stringify([{ kind: 'file', id: legacyFile!.id }]),
      JSON.stringify({ items: { [`file:${legacyFile!.id}`]: { id: legacyFile!.id, storage_key: storageKey } } }),
      JSON.stringify({ items: { [`file:${legacyFile!.id}`]: { id: legacyFile!.id, storage_key: storageKey } } }),
      JSON.stringify({ [`file:${legacyFile!.id}`]: 1 })])
    await pool.query(`INSERT INTO workspaces(user_id,name,kind,folder_id)
      VALUES ($1,'已退役目录工作区','folder',$2)`, [owner, folder!.id])
    await pool.query(`INSERT INTO workspaces(user_id,name,kind,project_id)
      VALUES ($1,'项目工作区','project',$2)`, [owner, project!.id])
    const { migrateLegacyFileUndoAnchors } = await import('../../src/modules/undo/legacy-file-anchors.js')
    const { migrateLegacyMindFileAnchors } = await import('../../src/modules/mind/legacy-file-anchors.js')
    assert.equal(await migrateLegacyFileUndoAnchors(pool, { async read() { return null }, async move() {} }), 1)
    if (process.platform === 'linux') {
      const { createWorkspaceFileReads } = await import('../../src/modules/workspaces/files.js')
      const { readPostgresProjectPathKey } = await import('../../src/modules/files/paths.js')
      assert.equal(await readPostgresProjectPathKey(pool, owner, project!.id), storageKey.split('/').slice(0, 5).join('/'))
      assert.equal((await createWorkspaceFileReads(pool, storageRoot).reference(owner, { projectId: project!.id }, '旧目录/保留.txt')).type, 'file')
      assert.equal(await migrateLegacyMindFileAnchors(pool, storageRoot), 3)
    }
    assert.equal(await migratePostgres(pool, 'check'), 'pending')
    assert.equal(await migratePostgres(pool, 'apply'), 'applied')
    assert.equal(await migratePostgres(pool, 'check'), 'applied')
    const removed = await pool.query<{ folders: string | null; fileFolderId: boolean; workspaceFolderId: boolean }>(`
      SELECT to_regclass('folders')::text AS folders,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='files' AND column_name='folder_id') AS "fileFolderId",
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='workspaces' AND column_name='folder_id') AS "workspaceFolderId"
    `)
    assert.deepEqual(removed.rows[0], { folders: null, fileFolderId: false, workspaceFolderId: false })
    assert.deepEqual((await pool.query('SELECT path FROM files WHERE user_id=$1', [owner])).rows,
      [{ path: storageKey }])
    const expectedFilePath = `/project/2026/11/升级项目 #${project!.id}/旧目录/保留.txt`
    assert.deepEqual((await pool.query<{ files: unknown }>(
      'SELECT files FROM conversation_messages WHERE session_id=$1', [session!.id],
    )).rows, [{ files: [
      { name: '保留.txt', file_path: expectedFilePath },
      { attach_id: 'a'.repeat(32), name: '临时附件.txt' },
    ] }])
    assert.deepEqual((await pool.query<{ email_attachment_file_paths: unknown }>(
      'SELECT email_attachment_file_paths FROM scheduled_tasks WHERE id=$1', [legacyTask!.id],
    )).rows, [{ email_attachment_file_paths: [expectedFilePath] }])
    assert.deepEqual((await pool.query<{ moves: unknown }>(
      'SELECT moves FROM project_undo_journals WHERE id=$1', [undoJournal!.id],
    )).rows, [{ moves: [
      { kind: 'file', from: storageKey, to: `${storageKey}.trash` }, { projectId: project!.id },
    ] }])
    const migratedUndo = await pool.query<{ target_refs: unknown; before_state: unknown; base_versions: unknown }>(
      'SELECT target_refs,before_state,base_versions FROM undo_operations WHERE id=$1', [legacyUndo!.id],
    )
    assert.deepEqual(migratedUndo.rows[0], {
      target_refs: [{ kind: 'file', path: storageKey }],
      before_state: { items: { [`file:${storageKey}`]: { path: storageKey } } },
      base_versions: { [`file:${storageKey}`]: 1 },
    })
    if (process.platform === 'linux') {
      const migratedMindRef = await pool.query<{ ref_id: number; ref_snapshot: unknown; deleted_at: Date | null }>(
        'SELECT ref_id,ref_snapshot,deleted_at FROM mind_nodes WHERE id=$1', [legacyMindRefId],
      )
      assert.ok(Number(migratedMindRef.rows[0]?.ref_id) < 0)
      assert.equal((migratedMindRef.rows[0]?.ref_snapshot as { fileReferenceId?: string }).fileReferenceId?.startsWith('path-'), true)
      assert.equal(migratedMindRef.rows[0]?.deleted_at, null)
      const migratedContent = await pool.query<{ content_md: string }>(
        'SELECT content_md FROM mind_nodes WHERE id=$1', [legacyMindTextId],
      )
      assert.match(migratedContent.rows[0]!.content_md, /gugu:\/\/open-object\/file\/path-/u)
      assert.doesNotMatch(migratedContent.rows[0]!.content_md, /gugu:\/\/open-object\/file\/[1-9]\d*/u)
      const migratedMessageContent = await pool.query<{ content: string }>(
        'SELECT content FROM conversation_messages WHERE session_id=$1', [session!.id],
      )
      assert.match(migratedMessageContent.rows[0]!.content, /\[\[file:path-/u)
      assert.doesNotMatch(migratedMessageContent.rows[0]!.content, /\[\[file:[1-9]\d*/u)
    }
    assert.equal(await readFile(join(storageRoot, storageKey), 'utf8'), '旧文件正文')
    assert.equal((await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='scheduled_tasks' AND column_name='email_attachment_file_ids'`)).rowCount, 0)
    assert.deepEqual((await pool.query('SELECT name,kind,project_id FROM workspaces WHERE user_id=$1 ORDER BY name', [owner])).rows,
      [{ name: '项目工作区', kind: 'project', project_id: project!.id }])
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end(); await rm(storageRoot, { recursive: true, force: true }) }
  }
})
