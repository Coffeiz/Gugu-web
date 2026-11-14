import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresFileContentOperations } from '../../src/domains/files/file-content-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '11111111-1111-4111-8111-111111111111'
const otherOwnerId = '22222222-2222-4222-8222-222222222222'

test('PostgreSQL Local 正文保存执行版本 CAS、更新正文并保存撤销附件和资源事件', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 正文保存回归',
}, async () => {
  const schema = `gugu_file_content_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-file-content-'))
  const published: number[] = []
  try {
    await pool.query(`
      CREATE TABLE projects (
        id integer PRIMARY KEY, user_id uuid NOT NULL, name text, color text,
        start_date date, created_at timestamptz NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE folders (
        id integer PRIMARY KEY, user_id uuid NOT NULL, parent_id integer, name text,
        project_id integer, workspace_directory_id integer, deleted_at timestamptz
      );
      CREATE TABLE files (
        id serial PRIMARY KEY, user_id uuid NOT NULL, display_name text NOT NULL, ext text NOT NULL,
        space text NOT NULL, project_id integer, folder_id integer, workspace_directory_id integer,
        stage_name text NOT NULL, mind_map_id integer, storage_key text NOT NULL, version integer NOT NULL,
        size text NOT NULL, size_bytes bigint NOT NULL, mime_type text, img_width integer, img_height integer,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE undo_operations (
        id text PRIMARY KEY, user_id uuid NOT NULL, undo_context_id text, group_id text, resource text,
        action text, target_refs jsonb, before_state jsonb, after_state jsonb, base_versions jsonb,
        artifact_refs jsonb, actor_type text, status text, created_at timestamptz, expires_at timestamptz,
        undone_at timestamptz, failure_code text
      );
      CREATE TABLE file_sync_bindings (
        id serial PRIMARY KEY, user_id uuid NOT NULL, workspace_id integer, source text NOT NULL,
        mode text NOT NULL, root_path text NOT NULL, revision integer NOT NULL, gap_revision integer NOT NULL,
        root_fingerprint text NOT NULL, status text NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE TABLE file_sync_journal (
        id serial PRIMARY KEY, binding_id integer NOT NULL, user_id uuid NOT NULL, idempotency_key text NOT NULL,
        source text NOT NULL, operation text NOT NULL, object_type text NOT NULL, relative_path text NOT NULL,
        baseline_fingerprint text, observed_fingerprint text, revision integer NOT NULL, status text NOT NULL,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
        UNIQUE(binding_id,idempotency_key)
      );
      CREATE TABLE workspace_directories (
        id serial PRIMARY KEY, user_id uuid NOT NULL, directory_name text NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE workspaces (
        id serial PRIMARY KEY, user_id uuid NOT NULL, kind text NOT NULL, folder_id integer,
        project_id integer, directory_id integer, enabled boolean NOT NULL
      );
      CREATE TABLE file_sync_reconcile_runs (
        id uuid PRIMARY KEY, user_id uuid NOT NULL, binding_id integer NOT NULL, action text NOT NULL,
        allow_delete boolean NOT NULL, status text NOT NULL, binding_revision integer NOT NULL,
        gap_revision integer NOT NULL, root_fingerprint text NOT NULL, result_counts jsonb NOT NULL,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      INSERT INTO projects (id,user_id,name,color,start_date,created_at)
      VALUES (1,'${ownerId}','示例项目','lavender','2026-11-01',CURRENT_TIMESTAMP);
      INSERT INTO folders (id,user_id,parent_id,name,project_id,workspace_directory_id)
      VALUES (1,'${ownerId}',NULL,'会议',NULL,NULL);
      INSERT INTO files (user_id,display_name,ext,space,stage_name,storage_key,version,size,size_bytes,
        mime_type,created_at,updated_at) VALUES
        ('${ownerId}','备忘录','md','personal','','${ownerId}/个人文件/备忘录.md',1,'4 B',4,
         'text/markdown',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('${otherOwnerId}','私有','md','personal','','${otherOwnerId}/个人文件/私有.md',1,'6 B',6,
         'text/markdown',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('${ownerId}','Workspace 备忘录','md','workspace','','${ownerId}/workspace/notes/Workspace 备忘录.md',1,'9 B',9,
         'text/markdown',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('${ownerId}','项目简报','md','project', '', '${ownerId}/项目文件/2026/11/示例项目 #1/brief.md',1,'6 B',6,
         'text/markdown',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('${ownerId}','会议记录','md','personal','','${ownerId}/个人文件/会议/记录.md',1,'6 B',6,
         'text/markdown',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO workspace_directories (user_id,directory_name) VALUES ('${ownerId}','notes');
      INSERT INTO workspaces (user_id,kind,folder_id,project_id,directory_id,enabled) VALUES
        ('${ownerId}','directory',NULL,NULL,1,TRUE),
        ('${ownerId}','project',NULL,1,NULL,TRUE),
        ('${ownerId}','folder',1,NULL,NULL,TRUE);
      INSERT INTO file_sync_bindings
        (user_id,workspace_id,source,mode,root_path,revision,gap_revision,root_fingerprint,status,updated_at)
      VALUES
        ('${ownerId}',NULL,'local_directory','bidirectional','.',0,0,'${'a'.repeat(64)}','active',CURRENT_TIMESTAMP),
        ('${ownerId}',NULL,'local_directory','mirror_out','.',0,0,'${'b'.repeat(64)}','active',CURRENT_TIMESTAMP),
        ('${ownerId}',1,'local_directory','bidirectional','.',0,0,'${'c'.repeat(64)}','active',CURRENT_TIMESTAMP),
        ('${ownerId}',2,'local_directory','bidirectional','.',0,0,'${'d'.repeat(64)}','active',CURRENT_TIMESTAMP),
        ('${ownerId}',3,'local_directory','bidirectional','.',0,0,'${'e'.repeat(64)}','active',CURRENT_TIMESTAMP);
    `)
    const source = path.join(root, ownerId, '个人文件', '备忘录.md')
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, '旧内容')
    const foreign = path.join(root, otherOwnerId, '个人文件', '私有.md')
    await mkdir(path.dirname(foreign), { recursive: true })
    await writeFile(foreign, '不应读取')
    const workspaceSource = path.join(root, ownerId, 'workspace', 'notes', 'Workspace 备忘录.md')
    await mkdir(path.dirname(workspaceSource), { recursive: true })
    await writeFile(workspaceSource, '旧 Workspace 内容')
    const projectSource = path.join(root, ownerId, '项目文件', '2026', '11', '示例项目 #1', 'brief.md')
    await mkdir(path.dirname(projectSource), { recursive: true })
    await writeFile(projectSource, '旧项目简报')
    const folderSource = path.join(root, ownerId, '个人文件', '会议', '记录.md')
    await mkdir(path.dirname(folderSource), { recursive: true })
    await writeFile(folderSource, '旧会议记录')
    const operations = createPostgresFileContentOperations(pool, {
      storageRoot: root,
      async publishChanged(event) { published.push(event.entityId) },
    })

    const lockHolder = await pool.connect()
    let updated: { id: number; version: number; sizeBytes: number }
    try {
      await lockHolder.query('BEGIN')
      await lockHolder.query('SELECT pg_advisory_xact_lock($1::bigint)', ['-1553201451128869487'])
      let operationSettled = false
      const update = operations.update(ownerId, 1, '新内容\n', 1, {
        idempotencyKey: null, undoContextId: 'editor-tab', clientId: 'test-client',
      }).then((value) => {
        operationSettled = true
        return value as typeof updated
      }, (error: unknown) => {
        operationSettled = true
        throw error
      })
      await new Promise((resolve) => setTimeout(resolve, 80))
      assert.equal(operationSettled, false, '正文写入必须等待 Python 兼容的文件路径事务锁')
      await lockHolder.query('COMMIT')
      updated = await update
    } finally {
      await lockHolder.query('ROLLBACK').catch(() => undefined)
      lockHolder.release()
    }
    assert.equal(updated.version, 2)
    assert.equal(updated.sizeBytes, Buffer.byteLength('新内容\n'))
    assert.equal(await readFile(source, 'utf8'), '新内容\n')
    const operation = await pool.query<{ artifact_refs: Record<string, { before_key: string; after_key: string }> }>(
      'SELECT artifact_refs FROM undo_operations WHERE user_id=$1 AND undo_context_id=$2', [ownerId, 'editor-tab'],
    )
    const artifacts = operation.rows[0]!.artifact_refs['file:1']!
    assert.equal(await readFile(path.join(root, artifacts.before_key), 'utf8'), '旧内容')
    assert.equal(await readFile(path.join(root, artifacts.after_key), 'utf8'), '新内容\n')
    const journal = await pool.query<{
      relative_path: string; source: string; operation: string; observed_fingerprint: string; revision: number; status: string
    }>(
      `SELECT relative_path,source,operation,observed_fingerprint,revision,status
       FROM file_sync_journal WHERE user_id=$1 AND binding_id=1`, [ownerId],
    )
    assert.deepEqual(journal.rows[0], {
      relative_path: '个人文件/备忘录.md', source: 'file_api', operation: 'update',
      observed_fingerprint: createHash('sha256').update('新内容\n').digest('hex'), revision: 1, status: 'synced',
    })
    const mirror = await pool.query<{ revision: number; action: string; binding_revision: number; status: string }>(
      `SELECT binding.revision,run.action,run.binding_revision,run.status
       FROM file_sync_bindings binding JOIN file_sync_reconcile_runs run ON run.binding_id=binding.id
       WHERE binding.id=2 AND binding.user_id=$1`, [ownerId],
    )
    assert.deepEqual(mirror.rows[0], { revision: 1, action: 'mirror_out', binding_revision: 1, status: 'queued' })
    assert.deepEqual(published, [1])

    const workspaceUpdated = await operations.update(ownerId, 3, '新 Workspace 内容', 1, {
      idempotencyKey: null, undoContextId: null, clientId: 'workspace-client',
    }) as { id: number; version: number }
    assert.equal(workspaceUpdated.version, 2)
    assert.equal(await readFile(workspaceSource, 'utf8'), '新 Workspace 内容')
    const workspaceJournal = await pool.query<{ relative_path: string; observed_fingerprint: string }>(
      `SELECT relative_path,observed_fingerprint FROM file_sync_journal
       WHERE user_id=$1 AND binding_id=3`, [ownerId],
    )
    assert.deepEqual(workspaceJournal.rows[0], {
      relative_path: 'Workspace 备忘录.md',
      observed_fingerprint: createHash('sha256').update('新 Workspace 内容').digest('hex'),
    })

    await operations.update(ownerId, 4, '新项目简报', 1, {
      idempotencyKey: null, undoContextId: null, clientId: 'project-client',
    })
    await operations.update(ownerId, 5, '新会议记录', 1, {
      idempotencyKey: null, undoContextId: null, clientId: 'folder-client',
    })
    const projectJournal = await pool.query<{ relative_path: string }>(
      'SELECT relative_path FROM file_sync_journal WHERE user_id=$1 AND binding_id=4', [ownerId],
    )
    const folderJournal = await pool.query<{ relative_path: string }>(
      'SELECT relative_path FROM file_sync_journal WHERE user_id=$1 AND binding_id=5', [ownerId],
    )
    assert.equal(projectJournal.rows[0]?.relative_path, 'brief.md')
    assert.equal(folderJournal.rows[0]?.relative_path, '记录.md')
    assert.deepEqual(published, [1, 3, 4, 5])

    await assert.rejects(operations.update(ownerId, 1, '过期覆盖', 1, {
      idempotencyKey: null, undoContextId: null, clientId: null,
    }), (error: unknown) => error instanceof Error && error.message.includes('其他端修改'))
    assert.equal(await readFile(source, 'utf8'), '新内容\n')
    await assert.rejects(operations.update(ownerId, 2, '越权', 1, {
      idempotencyKey: null, undoContextId: null, clientId: null,
    }), (error: unknown) => error instanceof Error && error.message === '文件不存在')
    assert.equal(await readFile(foreign, 'utf8'), '不应读取')
    assert.deepEqual(published, [1, 3, 4, 5])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
