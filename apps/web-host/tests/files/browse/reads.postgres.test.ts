import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Pool } from 'pg'
import { createPostgresFileReadOperations } from '../../../src/modules/files/browse.js'
import { createDiskTrash } from '../../../src/modules/files/trash/disk.js'

const owner = '00000000-0000-4000-8000-000000000041'

function fakePool(query: (sql: string, values?: unknown[]) => Promise<{ rows?: unknown[] }> | { rows?: unknown[] }): Pool {
  return { async query(sql: string, values?: unknown[]) { return await query(sql, values) } } as unknown as Pool
}

function fileRow(overrides: Record<string, unknown> = {}) {
  return {
    path: `${owner}/notes/meeting.md`,
    display_name: '会议记录',
    ext: 'md',
    space: 'personal',
    workspace_directory_id: null,
    project_id: null,
    project_name: null,
    project_color: null,
    stage_name: '',
    mind_map_id: null,
    size: '1 KB',
    size_bytes: '1024',
    mime_type: 'text/markdown',
    created_at: '2026-11-12T10:20:30.123456',
    deleted_at: null,
    img_width: null,
    img_height: null,
    version: '3',
    ...overrides,
  }
}

test('file detail is owner scoped and maps the Python response fields and UTC timestamp', async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = []
  const operations = createPostgresFileReadOperations(fakePool((sql, values) => {
    queries.push({ sql, values })
    return { rows: [fileRow({ project_id: 9, project_name: '合成项目', project_color: 'blue #abc' })] }
  }))

  const key = `${owner}/notes/meeting.md`
  const response = await operations.getFile(owner, key) as Record<string, unknown>

  assert.equal(response.filePath, key)
  assert.equal(response.displayName, '会议记录')
  assert.equal(response.projectColor, '#abc')
  assert.equal(response.createdAt, '2026-11-12T10:20:30.123456Z')
  assert.match(queries[0]!.sql, /file\.user_id=\$2 AND file\.deleted_at IS NULL/)
  assert.match(queries[0]!.sql, /file\.path=\$1 AND file\.user_id=\$2/)
  assert.deepEqual(queries[0]!.values, [key, owner])
})

test('文件定位从授权根下的存储键返回路径，不查询关系目录表', async () => {
  const operations = createPostgresFileReadOperations(fakePool(sql => {
    if (sql.includes('FROM files file')) return { rows: [fileRow({ path: `${owner}/个人文件/资料/子目录/会议记录.md` })] }
    throw new Error('只允许查询文件记录')
  }))
  const response = await operations.getFileLocation(owner, `${owner}/个人文件/资料/子目录/会议记录.md`) as { pathFile: { directoryId: string; relativePath: string } }
  assert.deepEqual(response.pathFile, { directoryId: 'personal', relativePath: '资料/子目录/会议记录.md' })
  assert.equal('folderPath' in response, false)
})

test('文件定位拒绝不属于授权根的存储键', async () => {
  const operations = createPostgresFileReadOperations(fakePool(() => ({ rows: [fileRow({ path: `${owner}/其他目录/private.md` })] })))
  await assert.rejects(operations.getFileLocation(owner, `${owner}/其他目录/private.md`), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'not_found')
})

test('最近文件摘要按请求数量读取', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const operations = createPostgresFileReadOperations(fakePool((sql, values) => {
    calls.push({ sql, values })
    return { rows: [fileRow()] }
  }))
  const summary = await operations.getSummary(owner, 5) as { recentFiles: unknown[] }
  assert.equal(summary.recentFiles.length, 1)
  assert.deepEqual(calls[0]!.values, [owner, 5])
})

test('文件库计数使用个人目录和已授权项目目录，不查询旧文件夹表', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-library-counts-'))
  try {
    const personal = path.join(root, owner, '个人文件')
    const project = path.join(root, owner, '项目文件', '2026', '01', '合成项目 #7')
    await mkdir(path.join(personal, '个人目录'), { recursive: true })
    await writeFile(path.join(personal, '个人.txt'), '内容')
    await writeFile(path.join(personal, '待删除.txt'), '内容')
    const trash = createDiskTrash(root, async identity => `${identity}/个人文件`)
    assert.ok(await trash.store(owner, 'personal', '待删除.txt', `${owner}/个人文件/待删除.txt`, '2026-01-01T00:00:00Z'))
    await mkdir(path.join(project, '子目录', '嵌套'), { recursive: true })
    await writeFile(path.join(project, '子目录', '项目.txt'), '内容')
    const operations = createPostgresFileReadOperations(fakePool((sql, values) => {
      assert.match(sql, /FROM projects WHERE user_id=\$1 AND deleted_at IS NULL/)
      assert.deepEqual(values, [owner])
      return { rows: [{ id: 7, name: '合成项目', start_date: '2026-01-01', created_at: '2026-01-01' }] }
    }), root)
    assert.deepEqual(await operations.getLibraryCounts(owner), {
      personalFileCount: 1, personalFolderCount: 1, projectFileCount: 1,
      projectFolderCount: 2, trashFileCount: 1, trashFolderCount: 0,
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('存储统计按物理文件计算并忽略符号链接和其他用户', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-storage-usage-'))
  try {
    const dir = path.join(root, owner, '个人文件', '子目录')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, '文件.txt'), '正文')
    await symlink('/etc/passwd', path.join(dir, '外部链接'))
    await mkdir(path.join(root, 'another-owner', '个人文件'), { recursive: true })
    await writeFile(path.join(root, 'another-owner', '个人文件', '文件.txt'), '不计入')
    const operations = createPostgresFileReadOperations(fakePool(() => { throw new Error('不得查询旧文件表') }), root)
    assert.deepEqual(await operations.getStorage(owner), { used_bytes: Buffer.byteLength('正文') })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('file content opens only an owned Local key and reports the physical byte length', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-file-content-adapter-'))
  try {
    const key = `${owner}/notes/meeting.md`
    const target = path.join(root, key)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, 'physical-body')
    const operations = createPostgresFileReadOperations(
      fakePool(() => ({ rows: [fileRow({ path: key, size_bytes: '1' })] })),
      root,
    )

    const source = await operations.openContent(owner, key)
    assert.ok(source)
    assert.equal(source.size, Buffer.byteLength('physical-body'))
    assert.equal(source.fileName, '会议记录.md')
    assert.equal((await source.handle.readFile()).toString(), 'physical-body')
    await source.handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('file content refuses traversal keys and symlinks that point outside Local storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-file-content-path-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'gugu-file-content-outside-'))
  try {
    const outsideFile = path.join(outside, 'secret.txt')
    await writeFile(outsideFile, 'synthetic')
    const ownerRoot = path.join(root, owner)
    await mkdir(ownerRoot, { recursive: true })
    await symlink(outsideFile, path.join(ownerRoot, 'link.txt'))

    const traversal = createPostgresFileReadOperations(
      fakePool(() => ({ rows: [fileRow({ path: `${owner}/../secret.txt` })] })), root,
    )
    await assert.rejects(traversal.openContent(owner, `${owner}/notes/meeting.md`), (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error
        && (error as { code: unknown }).code === 'not_found')

    const symlinked = createPostgresFileReadOperations(
      fakePool(() => ({ rows: [fileRow({ path: `${owner}/link.txt` })] })), root,
    )
    await assert.rejects(symlinked.openContent(owner, `${owner}/notes/meeting.md`), (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error
        && (error as { code: unknown }).code === 'not_found')
    assert.equal((await readFile(outsideFile)).toString(), 'synthetic')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('读取旧导入文件仅允许当前用户 imported 子树且拒绝符号链接', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'gugu-import-read-'))
  const outside=await mkdtemp(path.join(os.tmpdir(),'gugu-import-outside-'))
  const hex=owner.replaceAll('-',''),key=`${hex}/.data-portability/imported/job/file`,target=path.join(root,...key.split('/'))
  try {
    await mkdir(path.dirname(target),{recursive:true});await writeFile(target,'导入正文')
    const ops=(path:string)=>createPostgresFileReadOperations(fakePool(()=>({rows:[fileRow({path})]})), root)
    const opened=await ops(key).openContent(owner,key);assert.ok(opened)
    assert.equal((await opened.handle.readFile()).toString(),'导入正文');await opened.handle.close()
    for(const bad of [`${hex}/其他/file`,`22222222222242228222222222222222/.data-portability/imported/job/file`])
      assert.equal(await ops(bad).openContent(owner,bad),null)
    await assert.rejects(ops(`${hex}/.data-portability/imported/../rollback/file`).openContent(owner,`${hex}/.data-portability/imported/../rollback/file`),
      (error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&error.code==='not_found')
    const secret=path.join(outside,'secret');await writeFile(secret,'外部正文')
    const linkKey=`${hex}/.data-portability/imported/job/link`;await symlink(secret,path.join(root,...linkKey.split('/')))
    await assert.rejects(ops(linkKey).openContent(owner,linkKey),(error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&error.code==='not_found')
    assert.equal(await readFile(secret,'utf8'),'外部正文')
  } finally {await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true})}
})

test('工作区文件定位使用用户拥有的目录根，并拒绝其他目录的存储键', async () => {
  let key = `${owner}/workspace/default/docs/a.md`
  const operations = createPostgresFileReadOperations(fakePool((sql, values) => {
    if (sql.includes('FROM files file')) return { rows: [fileRow({ space: 'workspace', workspace_directory_id: 7, path: key })] }
    if (sql.includes('FROM workspace_directories')) {
      assert.deepEqual(values, [7, owner])
      return { rows: [{ directory_name: 'default' }] }
    }
    throw new Error('未预期的查询')
  }))
  const result = await operations.getFileLocation(owner, key) as { pathFile: { directoryId: number; relativePath: string } }
  assert.deepEqual(result.pathFile, { directoryId: 7, relativePath: 'docs/a.md' })
  key = `${owner}/workspace/other/a.md`
  await assert.rejects(operations.getFileLocation(owner, key), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'not_found')
})

test('项目文件定位使用当前用户项目目录并拒绝其他项目路径', async () => {
  let key = `${owner}/项目文件/2026/01/项目甲 #7/docs/a.md`
  const operations = createPostgresFileReadOperations(fakePool((sql, values) => {
    if (sql.includes('FROM files file')) return { rows: [fileRow({ space: 'project', project_id: 7, path: key })] }
    if (sql.includes('FROM projects')) {
      assert.deepEqual(values, [7, owner])
      return { rows: [{ name: '项目甲', start_date: '2026-01-01', created_at: '2026-01-01' }] }
    }
    throw new Error('未预期的查询')
  }))
  const result = await operations.getFileLocation(owner, key) as { pathFile: { directoryId: string; relativePath: string } }
  assert.deepEqual(result.pathFile, { directoryId: 'project:7', relativePath: 'docs/a.md' })
  key = `${owner}/项目文件/2026/01/项目乙 #8/a.md`
  await assert.rejects(operations.getFileLocation(owner, key), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'not_found')
})
