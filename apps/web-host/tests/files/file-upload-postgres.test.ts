import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresRuntime, tablesSql } from '@gugu/core/data'
import { createPostgresFileUploadOperations } from '../../src/domains/files/file-upload-postgres.js'
import { createWebAgentDownloadTool } from '../../src/domains/agent-sessions/tools/agent-web-download.js'
import { createAuthorizedWebAgentProductionRagRunPorts } from '../../src/domains/agent-sessions/tools/agent-rag-production-ports.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '11111111-1111-4111-8111-111111111111'

function loseUploadCommit(pool: Pool, reachesDatabase: boolean, recoveryAvailable = true): Pool {
  let lost = false
  return {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect()
      const rawQuery = client.query, query = rawQuery.bind(client), release = client.release.bind(client)
      let wroteFile = false
      client.query = (async (...args: Parameters<typeof client.query>) => {
        if (lost && !recoveryAvailable && typeof args[0] === 'string' && args[0].includes('FROM core_operation_receipts'))
          throw new Error('模拟恢复读取暂不可用')
        if (typeof args[0] === 'string' && /^\s*(INSERT INTO files|UPDATE files)\b/u.test(args[0])) wroteFile = true
        if (args[0] === 'COMMIT' && wroteFile) {
          if (reachesDatabase) await query('COMMIT')
          lost = true
          throw new Error('模拟提交时断连')
        }
        return (query as (...values: any[]) => Promise<any>)(...args)
      }) as typeof client.query
      client.release = ((error?: Error | boolean) => {
        client.query = rawQuery
        client.release = release
        release(error)
      }) as typeof client.release
      return client
    },
  } as unknown as Pool
}

test('PostgreSQL Local 上传创建文件并覆盖时同步更新物理正文、版本与配额', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 上传回归',
}, async () => {
  const schema = `gugu_file_upload_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-upload-postgres-'))
  const core = await createPostgresRuntime({ url: databaseUrl!, schema })
  const published: Array<{ operation: string; entityId: number }> = []
  try {
    await pool.query(`
      CREATE TABLE users (id uuid PRIMARY KEY, storage_limit_bytes bigint);
      CREATE TABLE projects (
        id serial PRIMARY KEY, user_id uuid NOT NULL, name varchar(200) NOT NULL, color varchar(300),
        start_date date, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at timestamptz
      );
      CREATE TABLE workspace_directories (
        id serial PRIMARY KEY, user_id uuid NOT NULL, directory_name varchar(200) NOT NULL, is_default boolean NOT NULL DEFAULT false, deleted_at timestamptz
      );
      CREATE TABLE folders (
        id serial PRIMARY KEY, user_id uuid NOT NULL, project_id integer, workspace_directory_id integer,
        parent_id integer, name varchar(255) NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE mind_maps (id serial PRIMARY KEY, user_id uuid NOT NULL, title varchar(300), deleted_at timestamptz);
      CREATE TABLE files (
        id serial PRIMARY KEY, user_id uuid NOT NULL, display_name varchar(300) NOT NULL, ext varchar(20) NOT NULL,
        space varchar(20) NOT NULL, workspace_directory_id integer, project_id integer, folder_id integer,
        stage_name varchar(100) NOT NULL, mind_map_id integer, storage_key varchar(500) NOT NULL,
        storage_backend varchar(20) NOT NULL, version integer NOT NULL, size varchar(50) NOT NULL,
        size_bytes bigint NOT NULL, mime_type varchar(200), img_width integer, img_height integer,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE storage_quota_ledgers (
        user_id uuid NOT NULL, category varchar(32) NOT NULL, used_bytes bigint NOT NULL,
        reserved_bytes bigint NOT NULL, limit_bytes bigint NOT NULL, status varchar(20) NOT NULL,
        updated_at timestamptz, PRIMARY KEY(user_id,category)
      );
      CREATE TABLE storage_quota_events (
        user_id uuid NOT NULL, category varchar(32) NOT NULL, operation varchar(32) NOT NULL,
        delta_bytes bigint NOT NULL, resource_type varchar(32), resource_id varchar(255),
        idempotency_key varchar(255) NOT NULL, metadata_json jsonb, created_at timestamptz NOT NULL
      );
      INSERT INTO users(id,storage_limit_bytes) VALUES ('${ownerId}',1000);
      INSERT INTO storage_quota_ledgers(user_id,category,used_bytes,reserved_bytes,limit_bytes,status)
      VALUES ('${ownerId}','file_library',0,0,1000,'active');
    `)
    await mkdir(root, { recursive: true })
    const operations = createPostgresFileUploadOperations(pool, {
      storageRoot: root,
      defaultLimitBytes: 1000,
      async removeCommittedBackup() { throw new Error('模拟清理失败') },
      async publishChanged(event) { published.push({ operation: event.operation, entityId: event.entityId }) },
    })
    const input = {
      space: 'personal', projectId: null, folderId: null, workspaceDirectoryId: null,
      stageName: '', mindMapId: null, onConflict: 'keep_both' as const, overwriteFileId: null,
    }
    const firstPath = path.join(root, 'first-upload')
    await writeFile(firstPath, 'before')
    const created = await operations.store(ownerId, {
      input, originalName: '记录.txt', mimeType: 'text/plain', path: firstPath,
      sizeBytes: 6, sha256: 'unused-in-storage-adapter-test', imgWidth: 4, imgHeight: 7,
    }, { idempotencyKey: null, undoContextId: null, clientId: 'test-client' }) as { id: number; version: number; sizeBytes: number }
    assert.equal(created.version, 1)
    assert.equal(created.sizeBytes, 6)
    assert.equal((await pool.query('SELECT img_width,img_height FROM files WHERE id=$1', [created.id])).rows[0]?.img_width, 4)
    assert.equal((await pool.query('SELECT img_width,img_height FROM files WHERE id=$1', [created.id])).rows[0]?.img_height, 7)
    assert.equal(await readFile(path.join(root, ownerId, '个人文件', '记录.txt'), 'utf8'), 'before')

    const overwritePath = path.join(root, 'overwrite-upload')
    await writeFile(overwritePath, 'after content')
    const overwritten = await operations.store(ownerId, {
      input: { ...input, onConflict: 'overwrite', overwriteFileId: created.id },
      originalName: '记录.txt', mimeType: 'text/plain', path: overwritePath,
      sizeBytes: 13, sha256: 'unused-in-storage-adapter-test', imgWidth: 8, imgHeight: 9,
    }, { idempotencyKey: null, undoContextId: null, clientId: 'test-client' }) as { id: number; version: number; sizeBytes: number }
    assert.equal(overwritten.id, created.id)
    assert.equal(overwritten.version, 2)
    assert.equal(overwritten.sizeBytes, 13)
    const imageDimensions = await pool.query<{ img_width: number; img_height: number }>(
      'SELECT img_width,img_height FROM files WHERE id=$1', [created.id],
    )
    assert.deepEqual(imageDimensions.rows[0], { img_width: 8, img_height: 9 })
    assert.equal(await readFile(path.join(root, ownerId, '个人文件', '记录.txt'), 'utf8'), 'after content')
    const quota = await pool.query<{ used_bytes: string }>(
      `SELECT used_bytes FROM storage_quota_ledgers WHERE user_id=$1 AND category='file_library'`, [ownerId],
    )
    assert.equal(Number(quota.rows[0]!.used_bytes), 13)
    assert.deepEqual(published.map((event) => event.operation), ['create', 'update'])
    const destination = path.join(root, ownerId, '个人文件', '记录.txt')
    const unknownPool = loseUploadCommit(pool, true)
    const upload = {input:{...input,onConflict:'overwrite' as const,overwriteFileId:created.id},originalName:'记录.txt',mimeType:'text/plain',path:overwritePath,sizeBytes:13,sha256:'synthetic',imgWidth:8,imgHeight:9}
    await writeFile(overwritePath, 'new contents!')
    const unknownOps=createPostgresFileUploadOperations(unknownPool,{storageRoot:root,defaultLimitBytes:1000,async publishChanged(){}})
    await assert.rejects(unknownOps.store(ownerId,upload,{idempotencyKey:null,undoContextId:null,clientId:null}),/模拟提交时断连/)
    assert.equal(await readFile(destination,'utf8'),'new contents!')
    const stage=(await readdir(path.dirname(destination))).find(name=>name.startsWith('.upload-stage-'))!
    assert.equal(await readFile(path.join(path.dirname(destination),stage,'content.old'),'utf8'),'after content')
    const existingStages=new Set(await readdir(path.dirname(destination)))
    const failedOps=createPostgresFileUploadOperations(pool,{storageRoot:root,defaultLimitBytes:1000,async publishChanged(){},async afterStore(){throw new Error('模拟写入失败')},restoreBackup(){throw new Error('模拟同步回滚失败')}})
    await assert.rejects(failedOps.store(ownerId,upload,{idempotencyKey:null,undoContextId:null,clientId:null}),/模拟写入失败/)
    const retained=(await readdir(path.dirname(destination))).find(name=>name.startsWith('.upload-stage-')&&!existingStages.has(name))!
    assert.equal(await readFile(path.join(path.dirname(destination),retained,'content.old'),'utf8'),'new contents!')
    const otherOwner='22222222-2222-4222-8222-222222222222'
    const foreignKey=`${otherOwner}/个人文件/秘密.txt`,foreignPath=path.join(root,...foreignKey.split('/'))
    await mkdir(path.dirname(foreignPath),{recursive:true});await writeFile(foreignPath,'他人正文')
    const corrupt=await pool.query<{id:number}>(`INSERT INTO files(user_id,display_name,ext,space,stage_name,storage_key,storage_backend,version,size,size_bytes,mime_type,created_at,updated_at) VALUES($1,'秘密','TXT','personal','',$2,'local',1,'6 B',6,'text/plain',now(),now()) RETURNING id`,[ownerId,foreignKey])
    const malicious={...upload,input:{...input,onConflict:'overwrite' as const,overwriteFileId:corrupt.rows[0]!.id},originalName:'秘密.txt'}
    await assert.rejects(operations.store(ownerId,malicious,{idempotencyKey:null,undoContextId:null,clientId:null}),/文件不存在/)
    assert.equal(await readFile(foreignPath,'utf8'),'他人正文')
    const importedKey=`${ownerId.replaceAll('-','')}/.data-portability/imported/synthetic/file`,importedPath=path.join(root,...importedKey.split('/'))
    await mkdir(path.dirname(importedPath),{recursive:true});await writeFile(importedPath,'导入正文')
    const imported=await pool.query<{id:number}>(`INSERT INTO files(user_id,display_name,ext,space,stage_name,storage_key,storage_backend,version,size,size_bytes,mime_type,created_at,updated_at) VALUES($1,'导入','TXT','personal','',$2,'local',1,'12 B',12,'text/plain',now(),now()) RETURNING id`,[ownerId,importedKey])
    await operations.store(ownerId,{...upload,input:{...input,onConflict:'overwrite',overwriteFileId:imported.rows[0]!.id},originalName:'导入.txt'},{idempotencyKey:null,undoContextId:null,clientId:null})
    assert.equal(await readFile(importedPath,'utf8'),'new contents!')

    await pool.query(`${tablesSql('postgres').receipts};
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,active_run_id text,workspace_id integer);
      CREATE TABLE workspaces(id serial PRIMARY KEY,user_id uuid,name text,kind text,folder_id integer,project_id integer,directory_id integer,enabled boolean DEFAULT true);
      CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,state text,token text,fence bigint,lease_expires_at timestamptz)`)
    const identity = { ownerId, sessionId: '1', runId: 'download-test' }
    const lease = { identity, token: 'synthetic-lease', fence: 1, mode: 'start' as const, cancelRequested: false,
      input: { userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64), v: 2 as const, source: 'web' as const } }
    await pool.query('INSERT INTO conversation_sessions(id,user_id,active_run_id) VALUES (1,$1,$2)', [ownerId, identity.runId])
    await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,1,$2,'selected',$3,1,CURRENT_TIMESTAMP+interval '5 minutes')", [ownerId, identity.runId, lease.token])
    const foreignFolder = await pool.query<{ id: number }>("INSERT INTO folders(user_id,name) VALUES ($1,'异主目录') RETURNING id", [randomUUID()])
    const abort = new AbortController()
    let requests = 0, released = 0
    let rebind: (() => Promise<unknown>) | undefined
    const makeRegistry = (upload = operations) => createAuthorizedWebAgentProductionRagRunPorts({
      core, pool, lease, storageRoot: root, enabled: () => true,
      selection: { modelIdentity: 'synthetic', contextScopeKey: lease.input.accessVersion, contextPolicy: { loadOwnerContext: true, memoryEnabled: false } },
      webDownload: createWebAgentDownloadTool({
        pool, db: core.db, lease, upload,
        async open(url) {
          requests++
          const endpoint = new URL(url).pathname
          return {
            status: endpoint === '/redirect' ? 302 : 200,
            headers: { 'content-type': 'text/plain', location: 'http://127.0.0.1/' },
            body: (async function* () {
              if (endpoint === '/cancel') abort.abort(new Error('合成取消'))
              if (endpoint === '/revoked') await pool.query("UPDATE agent_run_dispatch SET token='revoked'")
              if (endpoint === '/rebound') await rebind?.()
              yield Buffer.from(endpoint === '/large' ? 'x'.repeat(1100) : 'download body')
            })(),
            async cancel() { released++ },
          }
        },
      }),
    }).toolRegistry
    const registry = makeRegistry()
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      async execute(): Promise<never> { throw new Error('下载不调用沙盒') } }
    const call = { id: 'download', name: 'web_download', input: { url: 'https://example.test/record?token=synthetic', file_name: '下载.txt' } }
    const denied = await registry.tools.dispatch({ ...call, id: 'foreign', input: { ...call.input, folder_id: foreignFolder.rows[0]!.id } }, scope)
    assert.ok(denied.kind === 'completed' && !denied.successful)
    assert.equal(requests, 0)
    const downloaded = await registry.tools.dispatch(call, scope)
    assert.ok(downloaded.kind === 'completed' && downloaded.successful && downloaded.mutated, JSON.stringify(downloaded))
    assert.equal((downloaded.value as { source_url: string }).source_url, 'https://example.test/record')
    assert.equal(await readFile(path.join(root, ownerId, '个人文件', '下载.txt'), 'utf8'), 'download body')
    assert.deepEqual(await makeRegistry().tools.dispatch(call, scope), { ...downloaded, mutated: false })
    assert.equal(requests, 1)
    const project = await pool.query<{ id: number }>("INSERT INTO projects(user_id,name,start_date) VALUES ($1,'下载项目','2026-01-01') RETURNING id", [ownerId])
    const projectId = project.rows[0]!.id
    const folder = await pool.query<{ id: number }>("INSERT INTO folders(user_id,project_id,name) VALUES ($1,$2,'下载目录') RETURNING id", [ownerId, projectId])
    const inferred = await registry.tools.dispatch({ ...call, id: 'project', input: {
      ...call.input, folder_id: folder.rows[0]!.id, file_name: '项目内容.txt',
    } }, scope)
    assert.ok(inferred.kind === 'completed' && inferred.successful)
    assert.equal((inferred.value as { project_id: number }).project_id, projectId)
    assert.equal(await readFile(path.join(root, ownerId, '项目文件', '2026', '01', `下载项目 #${projectId}`, '下载目录', '项目内容.txt'), 'utf8'), 'download body')
    const uncertain = { ...call, id: 'uncertain', input: { ...call.input, file_name: '收据恢复.txt' } }
    const stages = async () => (await readdir(path.dirname(destination))).filter(name => name.startsWith('.upload-stage-')).sort()
    const stagesBefore = await stages()
    assert.equal((await makeRegistry(unknownOps).tools.dispatch(uncertain, scope)).kind, 'unknown')
    const recovered = await registry.tools.reconcile(uncertain, { ...identity, roundId: scope.roundId })
    assert.ok(recovered.kind === 'completed' && recovered.successful && !recovered.mutated)
    assert.deepEqual(await makeRegistry().tools.dispatch(uncertain, scope), recovered)
    assert.equal(await readFile(path.join(path.dirname(destination), '收据恢复.txt'), 'utf8'), 'download body')
    assert.deepEqual(await stages(), stagesBefore)
    assert.equal(requests, 3)
    for (const endpoint of ['redirect', 'large', 'cancel', 'revoked']) {
      const branch = { ...call, id: endpoint, input: { url: `https://example.test/${endpoint}`, file_name: `${endpoint}.txt` } }
      const outcome = await registry.tools.dispatch(branch, endpoint === 'cancel' ? { ...scope, signal: abort.signal } : scope)
      if (endpoint === 'cancel') assert.equal(outcome.kind, 'unknown')
      else assert.ok(outcome.kind === 'completed' && !outcome.successful, `${endpoint}: ${JSON.stringify(outcome)}`)
      await assert.rejects(readFile(path.join(root, ownerId, '个人文件', `${endpoint}.txt`)))
    }
    assert.equal(requests, 7)
    assert.equal(released, requests)
    const saved = await pool.query('SELECT result_json FROM core_operation_receipts')
    assert.equal(saved.rowCount, 3)
    assert.doesNotMatch(JSON.stringify(saved.rows), /synthetic|token=/u)
    const ledger = await pool.query("SELECT delta_bytes FROM storage_quota_events WHERE operation='web_download'")
    assert.deepEqual(ledger.rows.map(row => Number(row.delta_bytes)), [13, 13, 13])

    await pool.query('UPDATE agent_run_dispatch SET token=$1', [lease.token])
    const downloadTo = (id: string, fields: Record<string, unknown> = {}) => registry.tools.dispatch({
      id, name: 'web_download', input: { url: `https://example.test/${id}`, file_name: `${id}.txt`, ...fields },
    }, scope)
    const absent = await downloadTo('absent', { space: 'workspace' })
    assert.ok(absent.kind === 'completed' && !absent.successful)
    assert.equal(requests, 7)
    async function directoryWorkspace(owner: string, name: string, isDefault: boolean) {
      const { rows: [directory] } = await pool.query<{ id: number }>(
        'INSERT INTO workspace_directories(user_id,directory_name,is_default) VALUES ($1,$2,$3) RETURNING id',
        [owner, name, isDefault],
      )
      const { rows: [workspace] } = await pool.query<{ id: number }>(
        "INSERT INTO workspaces(user_id,name,kind,directory_id) VALUES ($1,$2,'directory',$3) RETURNING id",
        [owner, name, directory!.id],
      )
      return { id: workspace!.id, directoryId: directory!.id }
    }
    const defaultWorkspace = await directoryWorkspace(ownerId, '合成默认目录', true)
    const bound = await directoryWorkspace(ownerId, '合成绑定目录', false)
    const foreign = await directoryWorkspace(otherOwner, '合成异主目录', true)
    const bind = (workspaceId: number) => pool.query('UPDATE conversation_sessions SET workspace_id=$1 WHERE id=1', [workspaceId])
    const defaultResult = await downloadTo('default')
    assert.ok(defaultResult.kind === 'completed' && defaultResult.successful, JSON.stringify(defaultResult))
    assert.equal(await readFile(path.join(root, ownerId, 'workspace', '合成默认目录', 'default.txt'), 'utf8'), 'download body')
    assert.equal((await pool.query('SELECT workspace_id FROM conversation_sessions WHERE id=1')).rows[0].workspace_id, null)

    await bind(bound.id)
    const nested = await pool.query<{ id: number }>("INSERT INTO folders(user_id,workspace_directory_id,name) VALUES ($1,$2,'合成子目录') RETURNING id", [ownerId, bound.directoryId])
    const explicit = await downloadTo('explicit', { space: 'workspace', folder_id: nested.rows[0]!.id })
    assert.ok(explicit.kind === 'completed' && explicit.successful, JSON.stringify(explicit))
    assert.equal(await readFile(path.join(root, ownerId, 'workspace', '合成绑定目录', '合成子目录', 'explicit.txt'), 'utf8'), 'download body')
    const unrelated = await pool.query<{ id: number }>("INSERT INTO folders(user_id,workspace_directory_id,name) VALUES ($1,$2,'其他子目录') RETURNING id", [ownerId, defaultWorkspace.directoryId])
    const wrongDir = await downloadTo('wrongDir', { space: 'workspace', folder_id: unrelated.rows[0]!.id })
    assert.ok(wrongDir.kind === 'completed' && !wrongDir.successful)
    assert.equal(requests, 9)
    const override = await downloadTo('override', { space: 'personal' })
    assert.ok(override.kind === 'completed' && override.successful)
    assert.equal(await readFile(path.join(root, ownerId, '个人文件', 'override.txt'), 'utf8'), 'download body')

    const projectWorkspace = await pool.query<{ id: number }>("INSERT INTO workspaces(user_id,name,kind,project_id) VALUES ($1,'合成项目工作区','project',$2) RETURNING id", [ownerId, projectId])
    await bind(projectWorkspace.rows[0]!.id)
    const projectExpected = await downloadTo('not-directory', { space: 'workspace' })
    assert.ok(projectExpected.kind === 'completed' && !projectExpected.successful)
    assert.deepEqual((projectExpected.value as { expected: unknown }).expected, { space: 'project', project_id: projectId, folder_id: null })
    const projectDefault = await downloadTo('bound-project')
    assert.ok(projectDefault.kind === 'completed' && projectDefault.successful)
    assert.equal(await readFile(path.join(root, ownerId, '项目文件', '2026', '01', `下载项目 #${projectId}`, 'bound-project.txt'), 'utf8'), 'download body')
    await bind(foreign.id)
    const foreignWorkspace = await downloadTo('foreign-workspace', { space: 'workspace' })
    assert.ok(foreignWorkspace.kind === 'completed' && !foreignWorkspace.successful)
    assert.equal(requests, 11)

    await bind(bound.id)
    rebind = () => bind(defaultWorkspace.id)
    const moved = await downloadTo('rebound')
    assert.ok(moved.kind === 'completed' && !moved.successful)
    assert.match(JSON.stringify(moved.value), /文件落点已变化/u)
    await assert.rejects(readFile(path.join(root, ownerId, 'workspace', '合成绑定目录', 'rebound.txt')))
    await assert.rejects(readFile(path.join(root, ownerId, 'workspace', '合成默认目录', 'rebound.txt')))
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM core_operation_receipts')).rows[0].count, 7)
    assert.equal(requests, 12)
    assert.equal(released, requests)

    const rollbackPool = loseUploadCommit(pool, false)
    let rollbackPublications = 0
    const rolledBack = createPostgresFileUploadOperations(rollbackPool, { storageRoot: root, defaultLimitBytes: 1000, async publishChanged() {
      rollbackPublications++
    } })
    const failed = { ...call, id: 'commit-not-reached', input: { ...call.input, file_name: '回滚清理.txt', space: 'personal' } }
    assert.equal((await makeRegistry(rolledBack).tools.dispatch(failed, scope)).kind, 'unknown')
    assert.equal((await registry.tools.reconcile(failed, { ...identity, roundId: scope.roundId })).kind, 'unknown')
    await assert.rejects(readFile(path.join(path.dirname(destination), '回滚清理.txt')), { code: 'ENOENT' })
    assert.deepEqual(await stages(), stagesBefore)
    const replacement = path.join(path.dirname(destination), '路径替换.txt')
    const replaced = createPostgresFileUploadOperations(rollbackPool, { storageRoot: root, defaultLimitBytes: 1000,
      async publishChanged() { rollbackPublications++ },
      async afterStore() { await rm(replacement); await writeFile(replacement, '独立文件未被删除') },
    })
    assert.equal((await makeRegistry(replaced).tools.dispatch({ ...failed, id: 'replaced', input: { ...failed.input, file_name: '路径替换.txt' } }, scope)).kind, 'unknown')
    assert.equal(await readFile(replacement, 'utf8'), '独立文件未被删除')
    assert.deepEqual(await stages(), stagesBefore)
    const unavailable = createPostgresFileUploadOperations(loseUploadCommit(pool, false, false), {
      storageRoot: root, defaultLimitBytes: 1000, async publishChanged() { rollbackPublications++ },
    })
    const pending = { ...failed, id: 'unavailable', input: { ...failed.input, file_name: '等待核对.txt' } }
    assert.equal((await makeRegistry(unavailable).tools.dispatch(pending, scope)).kind, 'unknown')
    const retainedDownload = (await stages()).find(name => !stagesBefore.includes(name))
    assert.ok(retainedDownload)
    assert.equal(await readFile(path.join(path.dirname(destination), retainedDownload, 'content'), 'utf8'), 'download body')
    assert.equal(await readFile(path.join(path.dirname(destination), '等待核对.txt'), 'utf8'), 'download body')
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM core_operation_receipts')).rows[0].count, 7)
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM storage_quota_events WHERE operation='web_download'")).rows[0].count, 7)
    assert.equal(rollbackPublications, 0)
  } finally {
    await core.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
