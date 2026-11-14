import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { Pool } from 'pg'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'
import { createPostgresFileArchiveOperations } from '../../src/domains/files/file-archive-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const secret = 'synthetic-file-archive-vite-secret'

test('Vite→Node Host→隔离 PostgreSQL 完成 Local 文件夹 ZIP 往返并保持 owner 与磁盘内容', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 集成测试',
}, async () => {
  const schema = `gugu_file_archive_vite_${randomUUID().replaceAll('-', '')}`
  const ownerId = randomUUID()
  const foreignOwnerId = randomUUID()
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const storageRoot = await mkdtemp(join(tmpdir(), 'gugu-file-archive-vite-'))
  const published: string[] = []
  const app = createApp({
    appName: 'Local file archive Vite integration',
    async isReady() { return true },
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId ? {
          id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
          imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    fileArchives: createPostgresFileArchiveOperations(pool, {
      storageRoot,
      fileSyncEnabled: false,
      defaultLimitBytes: 10_000_000,
      async publishCreatedFile(event) { published.push(`file:${event.ownerId}:${event.entityId}`) },
      async publishCreatedBatch(eventOwnerId, origin) { published.push(`batch:${eventOwnerId}:${origin ?? ''}`) },
    }),
  })
  let vite: { listen(): Promise<void>; close(): Promise<void>; httpServer?: { address(): string | { port: number } | null } } | undefined
  const previousProxyTarget = process.env.VITE_API_PROXY_TARGET

  try {
    await pool.query(`
      CREATE TABLE users(id uuid PRIMARY KEY,storage_limit_bytes bigint);
      CREATE TABLE projects(id integer PRIMARY KEY,user_id uuid,name text,color text,start_date date,created_at timestamptz,deleted_at timestamptz);
      CREATE TABLE workspace_directories(id integer PRIMARY KEY,user_id uuid,directory_name text,deleted_at timestamptz);
      CREATE TABLE folders(id serial PRIMARY KEY,user_id uuid NOT NULL,parent_id integer,name text NOT NULL,
        project_id integer,workspace_directory_id integer,deleted_at timestamptz);
      CREATE TABLE files(id serial PRIMARY KEY,user_id uuid NOT NULL,display_name text NOT NULL,ext text NOT NULL,
        space text NOT NULL,project_id integer,folder_id integer,workspace_directory_id integer,stage_name text NOT NULL,
        mind_map_id integer,storage_key text NOT NULL,storage_backend text NOT NULL,version integer NOT NULL,
        size text NOT NULL,size_bytes bigint NOT NULL,mime_type text,img_width integer,img_height integer,
        created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,deleted_at timestamptz);
      CREATE TABLE storage_quota_ledgers(user_id uuid,category text,used_bytes bigint,reserved_bytes bigint,
        limit_bytes bigint,status text,updated_at timestamptz,PRIMARY KEY(user_id,category));
      CREATE TABLE storage_quota_events(user_id uuid,category text,operation text,delta_bytes bigint,
        resource_type text,resource_id text,idempotency_key text,metadata_json jsonb,created_at timestamptz);
    `)
    await pool.query('INSERT INTO users VALUES ($1,10000000),($2,10000000)', [ownerId, foreignOwnerId])
    await pool.query(
      `INSERT INTO storage_quota_ledgers VALUES ($1,'file_library',4,0,10000000,'active',CURRENT_TIMESTAMP)`,
      [ownerId],
    )
    await pool.query(
      `INSERT INTO folders(id,user_id,parent_id,name,project_id,workspace_directory_id,deleted_at) VALUES
        (10,$1,NULL,'资料',NULL,NULL,NULL),(11,$1,10,'子目录',NULL,NULL,NULL),
        (12,$2,NULL,'他人目录',NULL,NULL,NULL)`, [ownerId, foreignOwnerId],
    )
    await pool.query(
      `INSERT INTO files(user_id,display_name,ext,space,project_id,folder_id,workspace_directory_id,
        stage_name,mind_map_id,storage_key,storage_backend,version,size,size_bytes,mime_type,img_width,img_height,
        created_at,updated_at,deleted_at)
      VALUES ($1,'笔记','txt','personal',NULL,11,NULL,'',NULL,$2,'local',1,'4 B',4,
        'text/plain',NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL)`,
      [ownerId, `${ownerId}/个人文件/资料/子目录/笔记.txt`],
    )
    const sourcePath = join(storageRoot, ownerId, '个人文件', '资料', '子目录', '笔记.txt')
    await mkdir(join(storageRoot, ownerId, '个人文件', '资料', '子目录'), { recursive: true })
    await writeFile(sourcePath, 'Local 正文')

    const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
    process.env.VITE_API_PROXY_TARGET = hostAddress
    const frontendRoot = resolve(process.cwd(), '../web')
    const requireFrontend = createRequire(resolve(frontendRoot, 'package.json'))
    const viteModule = requireFrontend('vite') as {
      createServer(options: Record<string, unknown>): Promise<{
        listen(): Promise<void>
        close(): Promise<void>
        httpServer?: { address(): string | { port: number } | null }
      }>
    }
    vite = await viteModule.createServer({
      configFile: resolve(frontendRoot, 'vite.config.js'),
      root: frontendRoot,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/api/v1/files`
    const token = createUserToken(ownerId, 1, secret)
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

    const unauthenticated = await fetch(`${base}/archive`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderIds: [10] }),
    })
    assert.equal(unauthenticated.status, 401)

    const foreign = await fetch(`${base}/archive`, {
      method: 'POST', headers, body: JSON.stringify({ folderIds: [12] }),
    })
    assert.equal(foreign.status, 404)

    const archiveResponse = await fetch(`${base}/archive`, {
      method: 'POST', headers, body: JSON.stringify({ folderIds: [10] }),
    })
    assert.equal(archiveResponse.status, 201)
    const archive = await archiveResponse.json() as { id: number; displayName: string; ext: string }
    assert.equal(archive.displayName, '资料')
    assert.equal(archive.ext, 'zip')
    const archiveRow = await pool.query<{ storage_key: string; size_bytes: number }>(
      'SELECT storage_key,size_bytes FROM files WHERE id=$1 AND user_id=$2', [archive.id, ownerId],
    )
    const archiveBytes = await readFile(join(storageRoot, archiveRow.rows[0]!.storage_key))
    const zip = await JSZip.loadAsync(archiveBytes)
    assert.equal(await zip.file('资料/子目录/笔记.txt')!.async('string'), 'Local 正文')

    const extractionResponse = await fetch(`${base}/unarchive`, {
      method: 'POST', headers, body: JSON.stringify({ fileId: archive.id }),
    })
    assert.equal(extractionResponse.status, 200)
    const extraction = await extractionResponse.json() as {
      created_count: number; file_ids: number[]; folder_ids: number[]
    }
    assert.equal(extraction.created_count, 3)
    assert.equal(extraction.file_ids.length, 1)
    assert.equal(extraction.folder_ids.length, 2)
    const extractedRow = await pool.query<{ storage_key: string; size_bytes: number | string }>(
      'SELECT storage_key,size_bytes FROM files WHERE id=$1 AND user_id=$2', [extraction.file_ids[0], ownerId],
    )
    assert.equal(Number(extractedRow.rows[0]!.size_bytes), Buffer.byteLength('Local 正文'))
    assert.equal(await readFile(join(storageRoot, extractedRow.rows[0]!.storage_key), 'utf8'), 'Local 正文')
    assert.deepEqual(published, [`file:${ownerId}:${archive.id}`, `batch:${ownerId}:`])
    const quota = await pool.query<{ operations: string[]; used_bytes: string }>(
      `SELECT ARRAY(SELECT operation FROM storage_quota_events WHERE user_id=$1 ORDER BY operation) operations,
              used_bytes FROM storage_quota_ledgers WHERE user_id=$1 AND category='file_library'`, [ownerId],
    )
    assert.deepEqual(quota.rows[0]?.operations, ['archive_compress', 'archive_extract'])
    assert.ok(Number(quota.rows[0]?.used_bytes) > 4)
  } finally {
    if (vite) await vite.close()
    await app.close().catch(() => undefined)
    if (previousProxyTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousProxyTarget
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
    await rm(storageRoot, { recursive: true, force: true })
  }
})
