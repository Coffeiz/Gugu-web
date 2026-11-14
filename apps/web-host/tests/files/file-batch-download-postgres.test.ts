import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresFileBatchDownloadOperations } from '../../src/domains/files/file-batch-download-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'

test('PostgreSQL Local 批量下载只打包 owner 文件，并保留目录层级和正文', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 批量下载回归',
}, async () => {
  const schema = `gugu_file_download_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-file-download-'))
  try {
    await pool.query(`
      CREATE TABLE folders(id integer PRIMARY KEY,user_id uuid,parent_id integer,name text,deleted_at timestamptz);
      CREATE TABLE files(id integer PRIMARY KEY,user_id uuid,display_name text,ext text,storage_key text,
        mime_type text,folder_id integer,deleted_at timestamptz);
      INSERT INTO folders VALUES
        (10,'${owner}',NULL,'资料',NULL),(11,'${owner}',10,'图片',NULL),(12,'${other}',NULL,'外部',NULL),
        (13,'${owner}',NULL,'空目录',NULL);
      INSERT INTO files VALUES
        (1,'${owner}','个人笔记','TXT','${owner}/个人文件/个人笔记.txt','text/plain',NULL,NULL),
        (2,'${owner}','图表','SVG','${owner}/个人文件/资料/图片/图表.svg','image/svg+xml',11,NULL),
        (3,'${other}','私有','TXT','${other}/个人文件/外部/私有.txt','text/plain',12,NULL);
    `)
    const contents = new Map([
      [`${owner}/个人文件/个人笔记.txt`, 'personal-body'],
      [`${owner}/个人文件/资料/图片/图表.svg`, '<svg/>'],
      [`${other}/个人文件/外部/私有.txt`, 'private-body'],
    ])
    for (const [key, content] of contents) {
      const target = path.join(root, key)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    const operations = createPostgresFileBatchDownloadOperations(pool, root)
    const bytes = await operations.build(owner, [1, 3], [10, 12])
    const zip = await JSZip.loadAsync(bytes)
    assert.deepEqual(Object.keys(zip.files).sort(), ['个人笔记.txt', '资料/', '资料/图片/', '资料/图片/图表.svg'].sort())
    assert.equal(await zip.file('个人笔记.txt')!.async('string'), 'personal-body')
    assert.equal(await zip.file('资料/图片/图表.svg')!.async('string'), '<svg/>')
    const folderDownload = await operations.buildFolder(owner, 10)
    assert.ok(folderDownload)
    assert.equal(folderDownload.folderName, '资料')
    const folderZip = await JSZip.loadAsync(folderDownload.bytes)
    assert.deepEqual(Object.keys(folderZip.files).sort(), ['资料/', '资料/图片/', '资料/图片/图表.svg'].sort())
    assert.equal(await folderZip.file('资料/图片/图表.svg')!.async('string'), '<svg/>')
    assert.equal(await operations.buildFolder(owner, 12), null)
    const emptyFolderDownload = await operations.buildFolder(owner, 13)
    assert.ok(emptyFolderDownload)
    assert.deepEqual(Object.keys((await JSZip.loadAsync(emptyFolderDownload.bytes)).files), [])
    await assert.rejects(operations.build(owner, [], [999]), (error: unknown) =>
      error instanceof Error && 'code' in error && (error as Error & { code: string }).code === 'not_found')
    await assert.rejects(operations.build(owner, [], []), (error: unknown) =>
      error instanceof Error && 'statusCode' in error && (error as Error & { statusCode: number }).statusCode === 400)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
