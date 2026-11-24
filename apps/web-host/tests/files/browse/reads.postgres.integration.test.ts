import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { Pool } from 'pg'
import test from 'node:test'
import { registerFileReadRoutes } from '../../../src/modules/files/browse.js'
import { createPostgresFileReadOperations } from '../../../src/modules/files/browse.js'
import { registerFileThumbnailRoute } from '../../../src/modules/files/content.js'
import { installHttpErrorHandler } from '../../../src/http/errors.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'

test('PostgreSQL 文件摘要、分类计数和存储用量按用户物理目录计算', {
  skip: !databaseUrl ? '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 文件读取回归'
    : process.platform !== 'linux' && '安全文件系统需要 Linux',
}, async () => {
  const schema = `gugu_file_reads_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const app = Fastify()
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'gugu-file-reads-thumbnail-'))
  installHttpErrorHandler(app)
  try {
    await pool.query(`
      CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE projects(
        id integer PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL, color text NOT NULL, deleted_at timestamptz, start_date date, created_at timestamptz
      );
      CREATE TABLE files(
        user_id uuid NOT NULL, display_name text NOT NULL, ext text NOT NULL,
        space text NOT NULL, workspace_directory_id integer, path text NOT NULL, project_id integer,
        stage_name text, mind_map_id integer, size text NOT NULL, size_bytes bigint NOT NULL,
        mime_type text, created_at timestamptz NOT NULL, deleted_at timestamptz, img_width integer,
        img_height integer, version integer NOT NULL DEFAULT 1
      );
      INSERT INTO users VALUES ('${owner}'),('${other}');
      INSERT INTO projects VALUES (7,'${owner}','项目甲','#abcdef',NULL,'2026-01-01','2026-01-01');
      INSERT INTO files(user_id,display_name,ext,space,workspace_directory_id,path,project_id,stage_name,mind_map_id,size,size_bytes,mime_type,created_at,deleted_at,img_width,img_height,version) VALUES
        ('${owner}','个人文件','TXT','personal',NULL,'${owner}/个人文件/个人文件.txt',NULL,'',NULL,'512 B',512,'text/plain','2026-11-13T10:00:00Z',NULL,NULL,NULL,1),
        ('${owner}','项目文件','MD','project',NULL,'${owner}/项目文件/2026/01/项目甲 #7/项目目录/项目文件.md',7,'阶段一',NULL,'768 B',768,'text/markdown','2026-11-13T11:00:00Z',NULL,NULL,NULL,2),
        ('${owner}','回收文件','TXT','personal',NULL,'${owner}/个人文件/回收文件.txt',NULL,'',NULL,'256 B',256,'text/plain','2026-11-13T12:00:00Z',now(),NULL,NULL,1),
        ('${other}','他人文件','TXT','personal',NULL,'${other}/个人文件/他人文件.txt',NULL,'',NULL,'99 B',99,'text/plain','2026-11-13T13:00:00Z',NULL,NULL,NULL,1);
    `)
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
      'base64',
    )
    await mkdir(path.join(storageRoot, owner), { recursive: true })
    await writeFile(path.join(storageRoot, owner, '个人文件', 'thumbnail.png'), image)
    await mkdir(path.join(storageRoot, owner, '个人文件'), { recursive: true })
    await writeFile(path.join(storageRoot, owner, '个人文件', '个人文件.txt'), '合成文本')
    await writeFile(path.join(storageRoot, owner, '个人文件', '统计.txt'), '合成内容')
    const operations = createPostgresFileReadOperations(pool, storageRoot)
    const ownerForRequest = (request: import('fastify').FastifyRequest) =>
      request.headers.authorization === 'Bearer files-read-other' ? other : owner
    registerFileReadRoutes(app, {
      requireUser: async (request) => {
        if (request.headers.authorization !== 'Bearer files-read-test'
          && request.headers.authorization !== 'Bearer files-read-other')
          throw Object.assign(new Error('未认证'), { statusCode: 401 })
      },
      ownerIdFromRequest: ownerForRequest,
      operations,
    })
    registerFileThumbnailRoute(app, {
      requireUser: async (request) => {
        if (request.headers.authorization !== 'Bearer files-read-test'
          && request.headers.authorization !== 'Bearer files-read-other')
          throw Object.assign(new Error('未认证'), { statusCode: 401 })
      },
      ownerIdFromRequest: ownerForRequest,
      operations,
    })

    const [summary, counts, storage, detail, location] = await Promise.all([
      app.inject({ url: '/api/v1/files/summary?recent_limit=2', headers: { authorization: 'Bearer files-read-test' } }),
      app.inject({ url: '/api/v1/files/library-counts', headers: { authorization: 'Bearer files-read-test' } }),
      app.inject({ url: '/api/v1/files/storage', headers: { authorization: 'Bearer files-read-test' } }),
      app.inject({ url: `/api/v1/files/by-path?${new URLSearchParams({ path: `${owner}/项目文件/2026/01/项目甲 #7/项目目录/项目文件.md` })}`, headers: { authorization: 'Bearer files-read-test' } }),
      app.inject({ url: `/api/v1/files/by-path/location?${new URLSearchParams({ path: `${owner}/项目文件/2026/01/项目甲 #7/项目目录/项目文件.md` })}`, headers: { authorization: 'Bearer files-read-test' } }),
    ])
    assert.equal(summary.statusCode, 200, summary.body)
    assert.deepEqual(summary.json<{ recentFiles: Array<{ filePath: string }> }>().recentFiles.map((file) => file.filePath), [
      `${owner}/项目文件/2026/01/项目甲 #7/项目目录/项目文件.md`, `${owner}/个人文件/个人文件.txt`,
    ])
    assert.equal(counts.statusCode, 200, counts.body)
    assert.deepEqual(counts.json(), {
      personalFileCount: 1, personalFolderCount: 0, projectFileCount: 0,
      projectFolderCount: 0, trashFileCount: 0, trashFolderCount: 0,
    })
    assert.equal(storage.statusCode, 200, storage.body)
    assert.deepEqual(storage.json(), { used_bytes: Buffer.byteLength('合成内容') })
    assert.equal(detail.statusCode, 200, detail.body)
    assert.equal(detail.json<{ projectName: string; folderName: string }>().projectName, '项目甲')
    assert.equal('folderName' in detail.json(), false)
    assert.equal(location.statusCode, 200, location.body)
    assert.deepEqual(location.json<{ pathFile: unknown }>().pathFile, { directoryId: 'project:7', relativePath: '项目目录/项目文件.md' })
    assert.equal((await app.inject({ url: '/api/v1/files/library-counts' })).statusCode, 401)
    await pool.query(`INSERT INTO files(user_id,display_name,ext,space,workspace_directory_id,path,project_id,stage_name,mind_map_id,size,size_bytes,mime_type,created_at,deleted_at,img_width,img_height,version) VALUES
        ('${owner}','合成图片','PNG','personal',NULL,'${owner}/个人文件/thumbnail.png',NULL,'',NULL,'1 B',1,'image/png','2026-11-13T14:00:00Z',NULL,1,1,1),
        ('${owner}','丢失图片','PNG','personal',NULL,'${owner}/个人文件/missing.png',NULL,'',NULL,'1 B',1,'image/png','2026-11-13T15:00:00Z',NULL,1,1,1)`)
    const imagePath = `${owner}/个人文件/thumbnail.png`
    const missingImagePath = `${owner}/个人文件/missing.png`
    const personalFilePath = `${owner}/个人文件/个人文件.txt`
    const fullThumbnail = await app.inject({
      url: `/api/v1/files/by-path/thumb?${new URLSearchParams({ path: imagePath, size: 'full' })}`,
      headers: { authorization: 'Bearer files-read-test' },
    })
    const smallThumbnail = await app.inject({
      url: `/api/v1/files/by-path/thumb?${new URLSearchParams({ path: imagePath, size: 'tiny' })}`,
      headers: { authorization: 'Bearer files-read-test' },
    })
    const otherThumbnail = await app.inject({
      url: `/api/v1/files/by-path/thumb?${new URLSearchParams({ path: imagePath })}`,
      headers: { authorization: 'Bearer files-read-other' },
    })
    const missingPhysicalThumbnail = await app.inject({
      url: `/api/v1/files/by-path/thumb?${new URLSearchParams({ path: missingImagePath })}`,
      headers: { authorization: 'Bearer files-read-test' },
    })
    const nonImageThumbnail = await app.inject({
      url: `/api/v1/files/by-path/thumb?${new URLSearchParams({ path: personalFilePath })}`,
      headers: { authorization: 'Bearer files-read-test' },
    })
    assert.equal(fullThumbnail.statusCode, 200, fullThumbnail.body)
    assert.equal(fullThumbnail.headers['content-type'], 'image/png')
    assert.deepEqual(fullThumbnail.rawPayload, image)
    assert.equal(smallThumbnail.statusCode, 200, smallThumbnail.body)
    assert.equal(smallThumbnail.headers['content-type'], 'image/webp')
    assert.equal(otherThumbnail.statusCode, 404)
    assert.equal(missingPhysicalThumbnail.statusCode, 404)
    assert.equal(missingPhysicalThumbnail.json<{ detail: string }>().detail, '物理文件丢失')
    assert.equal(nonImageThumbnail.statusCode, 415)
  } finally {
    await app.close()
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
    await rm(storageRoot, { recursive: true, force: true })
  }
})
