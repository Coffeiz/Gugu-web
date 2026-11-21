import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresStorageQuotaReconcilePort, measureStorageQuotaDirectory } from '../../../src/modules/files/storage/quota.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '11111111-1111-4111-8111-111111111111'
const otherOwnerId = '22222222-2222-4222-8222-222222222222'

test('Local 配额扫描不跟随符号链接，也不越出存储根目录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-quota-scan-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'gugu-quota-outside-'))
  try {
    const target = path.join(root, ownerId, 'workspace')
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'inside.txt'), 'abc')
    await writeFile(path.join(outside, 'secret.txt'), 'sensitive')
    await symlink(outside, path.join(target, 'linked-directory'))
    await symlink(path.join(outside, 'secret.txt'), path.join(target, 'linked-file'))
    assert.equal(await measureStorageQuotaDirectory(root, target, new AbortController().signal), 3)
    assert.equal(await measureStorageQuotaDirectory(root, outside, new AbortController().signal), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('尚未创建的用户存储根按零用量处理', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'gugu-quota-missing-'))
  const missingRoot = path.join(parent, 'not-created')
  try {
    assert.equal(await measureStorageQuotaDirectory(missingRoot, path.join(missingRoot, ownerId, 'workspace'), new AbortController().signal), 0)
  } finally { await rm(parent, { recursive: true, force: true }) }
})

test('PostgreSQL Local 全量对账统计文件库与未登记 Workspace，用账本事务记录增量', {
  skip: !databaseUrl && '需要隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL',
}, async () => {
  const schema = `gugu_quota_reconcile_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'gugu-quota-storage-'))
  try {
    await pool.query(`
      CREATE TABLE users(id uuid PRIMARY KEY,storage_limit_bytes bigint);
      CREATE TABLE files(user_id uuid,workspace_directory_id integer,storage_key text,size_bytes bigint,deleted_at timestamptz);
      CREATE TABLE storage_quota_ledgers(user_id uuid,category text,root_path text,limit_bytes bigint,used_bytes bigint,
        reserved_bytes bigint,status text,initialized_at timestamptz,last_reconciled_at timestamptz,updated_at timestamptz,
        UNIQUE(user_id,category));
      CREATE TABLE storage_quota_events(user_id uuid,category text,operation text,delta_bytes bigint,resource_type text,
        resource_id text,idempotency_key text,metadata_json jsonb,created_at timestamptz,UNIQUE(user_id,idempotency_key));
      INSERT INTO users VALUES ('${ownerId}',1000),('${otherOwnerId}',2000);
      INSERT INTO storage_quota_ledgers(user_id,category,used_bytes,reserved_bytes,limit_bytes,status,updated_at)
        VALUES ('${ownerId}','file_library',0,0,1000,'active',CURRENT_TIMESTAMP),
          ('${ownerId}','shell_persistent',0,0,1000,'active',CURRENT_TIMESTAMP),
          ('${ownerId}','shell_ephemeral',0,0,1000,'active',CURRENT_TIMESTAMP);
      INSERT INTO files VALUES ('${ownerId}',1,'${ownerId}/workspace/registered.txt',4,NULL);
    `)
    const files: Array<[string, string]> = [
      [path.join(ownerId, 'workspace', 'registered.txt'), 'four'],
      [path.join(ownerId, 'workspace', 'shell.txt'), '123456'],
      [path.join(ownerId, '个人文件', 'personal.txt'), 'abc'],
      [path.join(ownerId, 'trash', 'deleted.txt'), '12345'],
      [path.join(ownerId.replaceAll('-', ''), '.data-portability', 'imported', 'imported.txt'), '1234567'],
    ]
    for (const [relative, content] of files) {
      const filename = path.join(storageRoot, relative)
      await mkdir(path.dirname(filename), { recursive: true })
      await writeFile(filename, content)
    }
    const port = createPostgresStorageQuotaReconcilePort({
      pool,
      storageRoot,
      defaultFileLibraryLimit: () => 900,
      ephemeralLimit: () => 1024,
    })
    assert.deepEqual(await port.listUserIds(), [ownerId, otherOwnerId])
    await port.reconcileUser(ownerId, new AbortController().signal)
    const rows = await pool.query('SELECT category,used_bytes::text AS used_bytes,limit_bytes::text AS limit_bytes FROM storage_quota_ledgers WHERE user_id=$1 ORDER BY category', [ownerId])
    assert.deepEqual(rows.rows, [
      { category: 'file_library', used_bytes: '25', limit_bytes: '1000' },
      { category: 'shell_ephemeral', used_bytes: '0', limit_bytes: '1024' },
      { category: 'shell_persistent', used_bytes: '6', limit_bytes: '9223372036854775807' },
    ])
    const eventCount = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM storage_quota_events WHERE user_id=$1', [ownerId])
    assert.equal(eventCount.rows[0]?.count, '2')
    await port.reconcileUser(ownerId, new AbortController().signal)
    const repeatCount = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM storage_quota_events WHERE user_id=$1', [ownerId])
    assert.equal(repeatCount.rows[0]?.count, '2')
    assert.equal((await pool.query('SELECT 1 FROM storage_quota_ledgers WHERE user_id=$1', [otherOwnerId])).rowCount, 0)

    let concurrentWrite = false
    const concurrentPool = {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect()
        const query = client.query.bind(client)
        return {
          async query(...args: Parameters<typeof client.query>) {
            const result = await query(...args)
            if (!concurrentWrite && typeof args[0] === 'string' && args[0].includes('FROM files')) {
              concurrentWrite = true
              await pool.query(`UPDATE storage_quota_ledgers SET used_bytes=99,updated_at=CURRENT_TIMESTAMP + interval '1 minute'
                WHERE user_id=$1 AND category='file_library'`, [ownerId])
            }
            return result
          },
          release: client.release.bind(client),
        }
      },
    } as unknown as Pool
    await createPostgresStorageQuotaReconcilePort({
      pool: concurrentPool,
      storageRoot,
      defaultFileLibraryLimit: () => 900,
      ephemeralLimit: () => 1024,
    }).reconcileUser(ownerId, new AbortController().signal)
    assert.equal(concurrentWrite, true)
    const preserved = await pool.query<{ used_bytes: string }>("SELECT used_bytes::text FROM storage_quota_ledgers WHERE user_id=$1 AND category='file_library'", [ownerId])
    assert.equal(preserved.rows[0]?.used_bytes, '99')
    const concurrentEventCount = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM storage_quota_events WHERE user_id=$1', [ownerId])
    assert.equal(concurrentEventCount.rows[0]?.count, '2')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(storageRoot, { recursive: true, force: true })
  }
})
