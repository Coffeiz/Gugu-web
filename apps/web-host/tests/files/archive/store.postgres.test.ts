import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresFileArchiveOperations } from '../../../src/modules/files/archive/service.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '11111111-1111-4111-8111-111111111111'
const otherOwnerId = '22222222-2222-4222-8222-222222222222'

test('PostgreSQL Local 归档保留选中文件夹树并可解压回原空间', {
  skip: !databaseUrl && '需要隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL',
}, async () => {
  const schema = `gugu_file_archive_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'gugu-file-archive-'))
  const publishedFiles: number[] = []
  const publishedBatches: string[] = []
  const tempDirectories: string[] = []
  try {
    await pool.query(`
      CREATE TABLE users(id uuid PRIMARY KEY,storage_limit_bytes bigint);
      CREATE TABLE projects(id integer PRIMARY KEY,user_id uuid,name text,color text,start_date date,created_at timestamptz,deleted_at timestamptz);
      CREATE TABLE workspace_directories(id integer PRIMARY KEY,user_id uuid,directory_name text,deleted_at timestamptz);
      CREATE TABLE folders(id serial PRIMARY KEY,user_id uuid NOT NULL,parent_id integer,name text NOT NULL,
        project_id integer,workspace_directory_id integer,deleted_at timestamptz,
        created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,version integer NOT NULL);
      CREATE TABLE files(id serial PRIMARY KEY,user_id uuid NOT NULL,display_name text NOT NULL,ext text NOT NULL,
        space text NOT NULL,project_id integer,folder_id integer,workspace_directory_id integer,stage_name text NOT NULL,
        mind_map_id integer,storage_key text NOT NULL,storage_backend text NOT NULL,version integer NOT NULL,
        size text NOT NULL,size_bytes bigint NOT NULL,mime_type text,img_width integer,img_height integer,
        created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,deleted_at timestamptz);
      CREATE TABLE storage_quota_ledgers(user_id uuid,category text,used_bytes bigint,reserved_bytes bigint,
        limit_bytes bigint,status text,updated_at timestamptz,PRIMARY KEY(user_id,category));
      CREATE TABLE storage_quota_events(user_id uuid,category text,operation text,delta_bytes bigint,
        resource_type text,resource_id text,idempotency_key text,metadata_json jsonb,created_at timestamptz);
      CREATE TABLE core_operation_receipts(owner_id uuid,operation_id varchar(36),fingerprint varchar(64),method varchar(100),result_json text,created_at timestamptz,
        PRIMARY KEY(owner_id,operation_id));
      INSERT INTO users VALUES ('${ownerId}',10000000),('${otherOwnerId}',10000000);
      INSERT INTO storage_quota_ledgers VALUES ('${ownerId}','file_library',4,0,10000000,'active',CURRENT_TIMESTAMP);
      INSERT INTO folders(id,user_id,parent_id,name,project_id,workspace_directory_id,deleted_at,created_at,updated_at,version) VALUES
        (10,'${ownerId}',NULL,'资料',NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1),(11,'${ownerId}',10,'子目录',NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1),
        (12,'${otherOwnerId}',NULL,'他人目录',NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1);
      INSERT INTO files(user_id,display_name,ext,space,project_id,folder_id,workspace_directory_id,
        stage_name,mind_map_id,storage_key,storage_backend,version,size,size_bytes,mime_type,img_width,img_height,
        created_at,updated_at,deleted_at) VALUES
        ('${ownerId}','笔记','txt','personal',NULL,11,NULL,'',NULL,'${ownerId}/个人文件/资料/子目录/笔记.txt','local',1,'4 B',4,
          'text/plain',NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL),
        ('${otherOwnerId}','私有','txt','personal',NULL,12,NULL,'',NULL,'${otherOwnerId}/个人文件/他人目录/私有.txt','local',1,'6 B',6,
          'text/plain',NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL);
    `)
    const sourcePath = path.join(storageRoot, ownerId, '个人文件', '资料', '子目录', '笔记.txt')
    await mkdir(path.dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, '正文')
    const foreignPath = path.join(storageRoot, otherOwnerId, '个人文件', '他人目录', '私有.txt')
    await mkdir(path.dirname(foreignPath), { recursive: true })
    await writeFile(foreignPath, '不得读取')

    let releases = 0
    const trackedPool = {async connect() { const client=await pool.connect();const release=client.release.bind(client);client.release=(() => {releases++;release()}) as typeof client.release;return client }} as unknown as Pool
    const operations = createPostgresFileArchiveOperations(trackedPool, {
      storageRoot,
      fileSyncEnabled: false,
      defaultLimitBytes: 10000000,
      async cleanupTemp(directory) { tempDirectories.push(directory); throw new Error('模拟清理失败') },
      async publishCreatedFile(event) { publishedFiles.push(event.entityId) },
      async publishCreatedBatch(owner, origin) { publishedBatches.push(`${owner}:${origin ?? ''}`) },
    })
    const metadata = { idempotencyKey: null, undoContextId: null, clientId: 'archive-test' }
    const compressOperation = { receipt: { operationId: randomUUID(), fingerprint: 'a'.repeat(64), method: 'agent.file.compress' as const } }
    const archived = await operations.archive(ownerId, { fileIds: [], folderIds: [10] }, metadata, undefined, compressOperation) as {
      id: number; displayName: string; ext: string; folderId: number | null; sizeBytes: number
    }
    assert.deepEqual(await operations.archive(ownerId, { fileIds: [], folderIds: [10] }, metadata, undefined, compressOperation), archived,
      '同一 Run 收据重试返回原文件，防止重复压缩副作用')
    assert.equal(archived.displayName, '资料')
    assert.equal(archived.ext, 'zip')
    assert.equal(archived.folderId, null)
    assert.deepEqual(publishedFiles, [archived.id])

    const archiveRow = await pool.query<{ storage_key: string }>('SELECT storage_key FROM files WHERE id=$1', [archived.id])
    const archiveBytes = await readFile(path.join(storageRoot, archiveRow.rows[0]!.storage_key))
    const zip = await JSZip.loadAsync(archiveBytes)
    assert.deepEqual(Object.keys(zip.files).sort(), ['资料/', '资料/子目录/', '资料/子目录/笔记.txt'])
    assert.equal(await zip.file('资料/子目录/笔记.txt')!.async('string'), '正文')
    assert.equal(zip.file('资料/子目录/私有.txt'), null)

    const extractOperation = { receipt: { operationId: randomUUID(), fingerprint: 'b'.repeat(64), method: 'agent.file.extract' as const } }
    const extracted = await operations.unarchive(ownerId, { fileId: archived.id }, metadata, undefined, extractOperation) as {
      created_count: number; file_count: number; folder_count: number; skipped_count: number;
      file_ids: number[]; folder_ids: number[]
    }
    assert.deepEqual({
      created_count: extracted.created_count, file_count: extracted.file_count,
      folder_count: extracted.folder_count, skipped_count: extracted.skipped_count,
    }, { created_count: 3, file_count: 1, folder_count: 2, skipped_count: 0 })
    const filesBeforeReplay = Number((await pool.query('SELECT count(*)::int AS count FROM files WHERE user_id=$1', [ownerId])).rows[0]!.count)
    assert.deepEqual(await operations.unarchive(ownerId, { fileId: archived.id }, metadata, undefined, extractOperation), extracted,
      '同一 Run 收据重试返回既有解压结果，防止重复创建文件和目录')
    assert.equal(Number((await pool.query('SELECT count(*)::int AS count FROM files WHERE user_id=$1', [ownerId])).rows[0]!.count), filesBeforeReplay)
    assert.equal(extracted.file_ids.length, 1)
    assert.equal(extracted.folder_ids.length, 2)
    const extractedRow = await pool.query<{ storage_key: string; size_bytes: number | string }>(
      'SELECT storage_key,size_bytes FROM files WHERE id=$1 AND user_id=$2', [extracted.file_ids[0], ownerId])
    assert.equal(Number(extractedRow.rows[0]!.size_bytes), 6)
    assert.equal(await readFile(path.join(storageRoot, extractedRow.rows[0]!.storage_key), 'utf8'), '正文')
    assert.deepEqual(publishedBatches, [`${ownerId}:archive-test`])
    const quota = await pool.query<{ used_bytes: number | string; operations: string[] }>(
      `SELECT ledger.used_bytes,ARRAY(SELECT operation FROM storage_quota_events WHERE user_id=ledger.user_id ORDER BY operation) operations
       FROM storage_quota_ledgers ledger WHERE user_id=$1 AND category='file_library'`, [ownerId])
    assert.equal(Number(quota.rows[0]!.used_bytes),
      4 + archived.sizeBytes + Number(extractedRow.rows[0]!.size_bytes))
    assert.deepEqual(quota.rows[0]!.operations, ['archive_compress', 'archive_extract'])
    assert.equal(releases, 4, '两次原始调用与两次回执重放均应释放 PostgreSQL 连接')
    await assert.rejects(operations.archive(ownerId,{fileIds:[],folderIds:[]},metadata), /请先选择/)
    assert.equal(releases, 5)
    let loseCommitResponse = true
    const unknownPool = {async connect(){const client=await pool.connect();const query=client.query.bind(client)
      client.query=(async (...args:Parameters<typeof client.query>)=>{const result=await (query as (...args:any[])=>Promise<any>)(...args);if(args[0]==='COMMIT' && loseCommitResponse){loseCommitResponse=false;throw new Error('模拟提交后断连')}return result}) as typeof client.query
      return client}} as unknown as Pool
    const unknownOps=createPostgresFileArchiveOperations(unknownPool,{storageRoot,fileSyncEnabled:false,defaultLimitBytes:10000000,async publishCreatedFile(){},async publishCreatedBatch(){}})
    const uncertainCompress = { receipt: { operationId: randomUUID(), fingerprint: 'c'.repeat(64), method: 'agent.file.compress' as const } }
    await assert.rejects(unknownOps.archive(ownerId,{fileIds:[],folderIds:[10],name:'未知提交'},metadata,undefined,uncertainCompress),/压缩提交结果未知/)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM core_operation_receipts WHERE operation_id=$1',
      [uncertainCompress.receipt.operationId])).rows[0]!.count, 1, '已提交副作用必须与 Agent 操作回执原子持久化')
    const recovered = await unknownOps.archive(ownerId,{fileIds:[],folderIds:[10],name:'未知提交'},metadata,undefined,uncertainCompress) as { id: number }
    const unknownArchive=await pool.query<{id:number;storage_key:string}>("SELECT id,storage_key FROM files WHERE user_id=$1 AND display_name='未知提交'",[ownerId])
    assert.equal(unknownArchive.rowCount,1)
    assert.equal(recovered.id, unknownArchive.rows[0]!.id)
    assert.ok((await readFile(path.join(storageRoot,unknownArchive.rows[0]!.storage_key))).length>0)
    const beforeIds=(await pool.query<{id:number}>('SELECT id FROM files WHERE user_id=$1',[ownerId])).rows.map(row=>row.id)
    const uncertainExtract = { receipt: { operationId: randomUUID(), fingerprint: 'd'.repeat(64), method: 'agent.file.extract' as const } }
    let loseExtractCommitResponse = true
    const unknownExtractPool = {async connect(){const client=await pool.connect();const query=client.query.bind(client)
      client.query=(async (...args:Parameters<typeof client.query>)=>{const result=await (query as (...args:any[])=>Promise<any>)(...args);if(args[0]==='COMMIT' && loseExtractCommitResponse){loseExtractCommitResponse=false;throw new Error('模拟提交后断连')}return result}) as typeof client.query
      return client}} as unknown as Pool
    const unknownExtractOps=createPostgresFileArchiveOperations(unknownExtractPool,{storageRoot,fileSyncEnabled:false,defaultLimitBytes:10000000,
      async cleanupTemp(directory) { tempDirectories.push(directory) },
      async publishCreatedFile(){},async publishCreatedBatch(){}})
    await assert.rejects(unknownExtractOps.unarchive(ownerId,{fileId:archived.id},metadata,undefined,uncertainExtract), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'storage_error' && error.message.includes('提交结果未知'))
    const recoveredExtract = await unknownExtractOps.unarchive(ownerId,{fileId:archived.id},metadata,undefined,uncertainExtract) as { created_count: number }
    assert.equal(recoveredExtract.created_count, 3)
    const afterFiles=await pool.query<{id:number;storage_key:string}>('SELECT id,storage_key FROM files WHERE user_id=$1 AND NOT (id=ANY($2::int[]))',[ownerId,beforeIds])
    assert.equal(afterFiles.rowCount, 1, '提交应答丢失后的重试不得再次插入文件')
    assert.equal(await readFile(path.join(storageRoot,afterFiles.rows[0]!.storage_key),'utf8'),'正文')
    await writeFile(path.join(storageRoot, archiveRow.rows[0]!.storage_key),'损坏的 ZIP')
    await assert.rejects(operations.unarchive(ownerId,{fileId:archived.id},metadata), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'invalid_request' && error.message === '压缩包损坏')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    for (const directory of tempDirectories) await rm(directory, { recursive: true, force: true })
    await rm(storageRoot, { recursive: true, force: true })
  }
})
