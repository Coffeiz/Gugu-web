import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Pool } from 'pg'
import test from 'node:test'
import { registerFileReadRoutes } from '../../src/domains/files/file-reads.js'
import { createPostgresFileReadOperations } from '../../src/domains/files/file-reads-postgres.js'
import { installHttpErrorHandler } from '../../src/http/errors.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'

test('PostgreSQL 文件摘要、分类计数和存储快照按 owner 返回 Python 兼容结果', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 文件读取回归',
}, async () => {
  const schema = `gugu_file_reads_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const app = Fastify()
  installHttpErrorHandler(app)
  try {
    await pool.query(`
      CREATE TABLE users(id uuid PRIMARY KEY, storage_limit_bytes bigint);
      CREATE TABLE projects(
        id integer PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL, color text NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE folders(
        id integer PRIMARY KEY, user_id uuid NOT NULL, project_id integer, workspace_directory_id integer,
        parent_id integer, name text NOT NULL, version integer NOT NULL DEFAULT 1, deleted_at timestamptz
      );
      CREATE TABLE files(
        id integer PRIMARY KEY, user_id uuid NOT NULL, display_name text NOT NULL, ext text NOT NULL,
        space text NOT NULL, workspace_directory_id integer, storage_key text NOT NULL, project_id integer,
        stage_name text, folder_id integer, mind_map_id integer, size text NOT NULL, size_bytes bigint NOT NULL,
        mime_type text, created_at timestamptz NOT NULL, deleted_at timestamptz, img_width integer,
        img_height integer, version integer NOT NULL DEFAULT 1
      );
      CREATE TABLE storage_quota_ledgers(
        user_id uuid NOT NULL, category text NOT NULL, used_bytes bigint NOT NULL
      );
      INSERT INTO users VALUES ('${owner}',4096),('${other}',2048);
      INSERT INTO projects VALUES (7,'${owner}','项目甲','#abcdef',NULL);
      INSERT INTO folders VALUES
        (20,'${owner}',NULL,NULL,NULL,'个人目录',1,NULL),
        (21,'${owner}',NULL,NULL,NULL,'已删除目录',1,now()),
        (22,'${owner}',7,NULL,NULL,'项目目录',1,NULL),
        (23,'${other}',NULL,NULL,NULL,'他人目录',1,NULL);
      INSERT INTO files VALUES
        (1,'${owner}','个人文件','TXT','personal',NULL,'${owner}/个人文件.txt',NULL,'',NULL,NULL,'512 B',512,'text/plain','2026-11-13T10:00:00Z',NULL,NULL,NULL,1),
        (2,'${owner}','项目文件','MD','project',NULL,'${owner}/项目文件.md',7,'阶段一',22,NULL,'768 B',768,'text/markdown','2026-11-13T11:00:00Z',NULL,NULL,NULL,2),
        (3,'${owner}','回收文件','TXT','personal',NULL,'${owner}/回收文件.txt',NULL,'',NULL,NULL,'256 B',256,'text/plain','2026-11-13T12:00:00Z',now(),NULL,NULL,1),
        (4,'${other}','他人文件','TXT','personal',NULL,'${other}/他人文件.txt',NULL,'',NULL,NULL,'99 B',99,'text/plain','2026-11-13T13:00:00Z',NULL,NULL,NULL,1);
      INSERT INTO storage_quota_ledgers VALUES ('${owner}','file_library',1280);
    `)
    const operations = createPostgresFileReadOperations(pool, 8192)
    registerFileReadRoutes(app, {
      requireUser: async (request) => {
        if (request.headers.authorization !== 'Bearer files-read-test')
          throw Object.assign(new Error('未认证'), { statusCode: 401 })
      },
      ownerIdFromRequest: () => owner,
      operations,
    })

    const [summary, counts, storage, detail, location] = await Promise.all([
      app.inject({ url: '/api/v1/files/summary?recent_limit=2', headers: { authorization: 'Bearer files-read-test' } }),
      app.inject({ url: '/api/v1/files/library-counts', headers: { authorization: 'Bearer files-read-test' } }),
      app.inject({ url: '/api/v1/files/storage', headers: { authorization: 'Bearer files-read-test' } }),
      app.inject({ url: '/api/v1/files/2', headers: { authorization: 'Bearer files-read-test' } }),
      app.inject({ url: '/api/v1/files/2/location', headers: { authorization: 'Bearer files-read-test' } }),
    ])
    assert.equal(summary.statusCode, 200, summary.body)
    assert.deepEqual(summary.json<{ recentFiles: Array<{ id: number }> }>().recentFiles.map((file) => file.id), [2, 1])
    assert.equal(counts.statusCode, 200, counts.body)
    assert.deepEqual(counts.json(), {
      personalFileCount: 1, personalFolderCount: 1, projectFileCount: 1,
      projectFolderCount: 1, trashFileCount: 1, trashFolderCount: 1,
    })
    assert.equal(storage.statusCode, 200, storage.body)
    assert.deepEqual(storage.json(), { used_bytes: 1280, limit_bytes: 4096 })
    assert.equal(detail.statusCode, 200, detail.body)
    assert.equal(detail.json<{ projectName: string; folderName: string }>().projectName, '项目甲')
    assert.equal(detail.json<{ folderName: string }>().folderName, '项目目录')
    assert.equal(location.statusCode, 200, location.body)
    assert.deepEqual(location.json<{ folderPath: Array<{ name: string }> }>().folderPath.map((folder) => folder.name), ['项目目录'])
    assert.equal((await app.inject({ url: '/api/v1/files/library-counts' })).statusCode, 401)
  } finally {
    await app.close()
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
})
