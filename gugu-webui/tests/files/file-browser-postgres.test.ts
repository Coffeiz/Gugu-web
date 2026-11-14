import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Pool } from 'pg'
import test from 'node:test'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import { createPostgresFileBrowserOperations } from '../../src/domains/files/file-browser-postgres.js'
import { createPostgresFolderReadOperations } from '../../src/domains/files/folder-reads-postgres.js'
import { registerFileBrowserRoutes } from '../../src/domains/files/browser.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

test('PostgreSQL 文件库列表按 owner/scope 隔离，并以加密游标稳定分页和统计直属实体', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行随机 schema PostgreSQL 回归',
}, async () => {
  const schema = `gugu_file_browser_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const app = Fastify()
  installHttpErrorHandler(app)
  try {
    await pool.query(`
      CREATE COLLATION gugu_natural_zh (provider = icu, locale = 'zh-u-kn-true');
      CREATE TABLE projects (
        id serial PRIMARY KEY, user_id uuid NOT NULL, name varchar(200) NOT NULL,
        color varchar(300) NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE workspace_directories (
        id serial PRIMARY KEY, user_id uuid NOT NULL, name varchar(200) NOT NULL,
        deleted_at timestamptz
      );
      CREATE TABLE folders (
        id serial PRIMARY KEY, user_id uuid NOT NULL, project_id integer,
        workspace_directory_id integer, parent_id integer, name varchar(255) NOT NULL,
        version integer NOT NULL DEFAULT 1, deleted_at timestamptz
      );
      CREATE TABLE files (
        id serial PRIMARY KEY, user_id uuid NOT NULL, display_name varchar(255) NOT NULL,
        ext varchar(32) NOT NULL, space varchar(32) NOT NULL, workspace_directory_id integer,
        project_id integer, stage_name varchar(255), folder_id integer, mind_map_id integer,
        size bigint NOT NULL DEFAULT 0, size_bytes bigint NOT NULL DEFAULT 0,
        mime_type varchar(255), created_at timestamptz NOT NULL, deleted_at timestamptz,
        img_width integer, img_height integer, version integer NOT NULL DEFAULT 1
      );
    `)
    const project = await pool.query<{ id: number }>(
      `INSERT INTO projects(user_id,name,color) VALUES ($1,'项目甲','linear-gradient(#ABCDEF,#123456)') RETURNING id`, [ownerId],
    )
    const projectId = project.rows[0]!.id
    await pool.query(`INSERT INTO folders(user_id,project_id,name) VALUES ($1,$2,'项目目录')`, [ownerId, projectId])
    const workspace = await pool.query<{ id: number }>(
      `INSERT INTO workspace_directories(user_id,name) VALUES ($1,'资料区') RETURNING id`, [ownerId],
    )
    const workspaceId = workspace.rows[0]!.id
    const rootFolder = await pool.query<{ id: number }>(
      `INSERT INTO folders(user_id,workspace_directory_id,name) VALUES ($1,$2,'文档') RETURNING id`, [ownerId, workspaceId],
    )
    const rootFolderId = rootFolder.rows[0]!.id
    const childFolder = await pool.query<{ id: number }>(
      `INSERT INTO folders(user_id,workspace_directory_id,parent_id,name) VALUES ($1,$2,$3,'子目录') RETURNING id`,
      [ownerId, workspaceId, rootFolderId],
    )
    const childFolderId = childFolder.rows[0]!.id
    await pool.query(
      `INSERT INTO folders(user_id,workspace_directory_id,parent_id,name) VALUES ($1,$2,$3,'二级')`,
      [ownerId, workspaceId, childFolderId],
    )
    await pool.query(`INSERT INTO folders(user_id,workspace_directory_id,name) VALUES ($1,$2,'资料')`, [ownerId, workspaceId])
    await pool.query(`INSERT INTO folders(user_id,workspace_directory_id,name) VALUES ($1,$2,'越权目录')`, [otherOwnerId, workspaceId])
    await pool.query(`
      INSERT INTO files(user_id,display_name,ext,space,project_id,size,size_bytes,mime_type,created_at)
      VALUES ($1,'资料','TXT','project',$2,12,12,'text/plain','2026-11-13T10:00:00.123456Z'),
             ($1,'资料','TXT','project',$2,14,14,'text/plain','2026-11-13T10:00:00.123457Z'),
             ($3,'他人资料','TXT','project',$2,99,99,'text/plain','2026-11-13T10:00:00.123458Z')
    `, [ownerId, projectId, otherOwnerId])
    await pool.query(`
      INSERT INTO files(user_id,display_name,ext,space,workspace_directory_id,folder_id,size,size_bytes,mime_type,created_at)
      VALUES ($1,'说明','PDF','workspace',$2,$3,8,8,'application/pdf','2026-11-13T11:00:00Z'),
             ($1,'已删除','PDF','workspace',$2,$3,8,8,'application/pdf','2026-11-13T11:01:00Z'),
             ($4,'他人文件','PDF','workspace',$2,$3,8,8,'application/pdf','2026-11-13T11:02:00Z')
    `, [ownerId, workspaceId, rootFolderId, otherOwnerId])
    await pool.query(`UPDATE files SET deleted_at=now() WHERE display_name='已删除'`)

    const operations = createPostgresFileBrowserOperations(pool, 'synthetic file browser test secret')
    const folderReads = createPostgresFolderReadOperations(pool)
    assert.deepEqual(await folderReads.getFolder(ownerId, rootFolderId), {
      id: rootFolderId, projectId: null, workspaceDirectoryId: workspaceId, parentId: null,
      name: '文档', fileCount: 1, folderCount: 0, version: 1,
    })
    assert.deepEqual(await folderReads.getFolderLocation(ownerId, childFolderId), {
      folder: { id: childFolderId, projectId: null, workspaceDirectoryId: workspaceId,
        parentId: rootFolderId, name: '子目录', fileCount: 0, folderCount: 0, version: 1 },
      ancestors: [{ id: rootFolderId, projectId: null, workspaceDirectoryId: workspaceId,
        parentId: null, name: '文档', fileCount: 0, folderCount: 0, version: 1 }],
    })
    assert.equal(await folderReads.getFolder(otherOwnerId, rootFolderId), null)
    const resolvedFolders = await folderReads.resolvePaths!(ownerId, {
      projectId: null, workspaceDirectoryId: workspaceId, parentId: rootFolderId,
      paths: ['%E5%AD%90%E7%9B%AE%E5%BD%95/%E4%BA%8C%E7%BA%A7', '子目录/不存在', '越权目录/秘密'],
    }) as Array<{ name: string; workspaceDirectoryId: number | null }>
    assert.deepEqual(resolvedFolders.map((folder) => folder.name), ['子目录', '二级'])
    assert.ok(resolvedFolders.every((folder) => folder.workspaceDirectoryId === workspaceId))
    const resolvedProjectFolders = await folderReads.resolvePaths!(ownerId, {
      projectId, workspaceDirectoryId: null, parentId: null, paths: ['项目目录'],
    }) as Array<{ name: string; projectId: number | null }>
    assert.deepEqual(resolvedProjectFolders.map((folder) => folder.name), ['项目目录'])
    assert.ok(resolvedProjectFolders.every((folder) => folder.projectId === projectId))
    assert.deepEqual(await folderReads.resolvePaths!(otherOwnerId, {
      projectId: null, workspaceDirectoryId: null, parentId: rootFolderId, paths: ['子目录'],
    }), [])
    const appOwner = 'Bearer files-test'
    registerFileBrowserRoutes(app, {
      requireUser: async (request) => {
        if (request.headers.authorization !== appOwner) throw new Error('missing test authorization')
      },
      ownerIdFromRequest: () => ownerId,
      operations,
    })

    const first = await app.inject({
      method: 'GET', url: `/api/v1/files?space=project&project_id=${projectId}&limit=1&sort_by=createdAt&sort_order=asc`,
      headers: { authorization: appOwner },
    })
    assert.equal(first.statusCode, 200, first.body)
    const firstPage = first.json<{ items: Array<{ id: number; projectName: string; projectColor: string }>; has_more: boolean; next_cursor: string }>()
    assert.equal(firstPage.items.length, 1)
    assert.equal(firstPage.has_more, true)
    assert.equal(firstPage.items[0]!.projectName, '项目甲')
    assert.equal(firstPage.items[0]!.projectColor, '#ABCDEF')
    assert.ok(firstPage.next_cursor)

    const second = await app.inject({
      method: 'GET', url: `/api/v1/files?space=project&project_id=${projectId}&limit=1&sort_by=createdAt&sort_order=asc&cursor=${encodeURIComponent(firstPage.next_cursor)}`,
      headers: { authorization: appOwner },
    })
    assert.equal(second.statusCode, 200, second.body)
    const secondPage = second.json<{ items: Array<{ id: number }>; has_more: boolean }>()
    assert.equal(secondPage.items.length, 1)
    assert.notEqual(secondPage.items[0]!.id, firstPage.items[0]!.id)
    assert.equal(secondPage.has_more, false)

    const folderResponse = await app.inject({
      method: 'GET', url: `/api/v1/folders?workspace_directory_id=${workspaceId}&limit=1&sort_by=name&sort_order=asc`,
      headers: { authorization: appOwner },
    })
    assert.equal(folderResponse.statusCode, 200, folderResponse.body)
    const folderPage = folderResponse.json<{ items: Array<{
      id: number; projectId: number | null; workspaceDirectoryId: number | null
      parentId: number | null; name: string; fileCount: number; folderCount: number; version: number
    }>; has_more: boolean; next_cursor: string }>()
    assert.deepEqual(folderPage.items, [{
      id: rootFolderId, projectId: null, workspaceDirectoryId: workspaceId, parentId: null,
      name: '文档', fileCount: 1, folderCount: 1, version: 1,
    }])
    assert.equal(folderPage.has_more, true)
    const nextFolderPage = await app.inject({
      method: 'GET', url: `/api/v1/folders?workspace_directory_id=${workspaceId}&limit=1&sort_by=name&sort_order=asc&cursor=${encodeURIComponent(folderPage.next_cursor)}`,
      headers: { authorization: appOwner },
    })
    assert.equal(nextFolderPage.statusCode, 200, nextFolderPage.body)
    assert.equal(nextFolderPage.json<{ items: Array<{ name: string }>; has_more: boolean }>().items[0]!.name, '资料')
    assert.equal(nextFolderPage.json<{ items: unknown[]; has_more: boolean }>().has_more, false)

    const workspaceFiles = await app.inject({
      method: 'GET', url: `/api/v1/files?space=workspace&workspace_directory_id=${workspaceId}&folder_id=${rootFolderId}&ext=pdf`,
      headers: { authorization: appOwner },
    })
    assert.equal(workspaceFiles.statusCode, 200, workspaceFiles.body)
    assert.equal(workspaceFiles.json<{ items: unknown[] }>().items.length, 1)

    const invalidCursor = await app.inject({
      method: 'GET', url: `/api/v1/files?space=project&project_id=${projectId}&cursor=${encodeURIComponent(firstPage.next_cursor)}&sort_by=id`,
      headers: { authorization: appOwner },
    })
    assert.equal(invalidCursor.statusCode, 422)
    await assert.rejects(operations.listFolders(otherOwnerId, {
      limit: 10, cursor: null, sortBy: 'name', sortOrder: 'asc', projectId: null,
      workspaceDirectoryId: workspaceId, parentId: null,
    }), (error: unknown) => (error as { code?: string }).code === 'not_found')
    await assert.rejects(operations.listFolders(otherOwnerId, {
      limit: 10, cursor: null, sortBy: 'name', sortOrder: 'asc', projectId: projectId,
      workspaceDirectoryId: null, parentId: null,
    }), (error: unknown) => (error as { code?: string }).code === 'not_found')
  } finally {
    await app.close()
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
})
