import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGlobalSearchOperations, parseGlobalSearchQuery } from '@gugu/core'
import { createMindFileReferences } from '../../src/modules/mind/file-references.js'
import { createDiskFileSearchSources } from '../../src/modules/search/files.js'

const owner = '22345678-abcd-4ef0-8012-123456789123'
const other = '12345678-abcd-4ef0-8012-123456789123'

test('全局搜索匹配 Shell 文件及非默认工作区相对路径，排除其他用户、回收站和符号链接', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-files-search-'))
  try {
    for (const location of [`${owner}/个人文件/阶段`, `${owner}/workspace/custom/子目录`, `${owner}/trash`, `${other}/个人文件`, `${owner}/项目文件/2026/04/测试 #1`])
      await mkdir(join(root, location), { recursive: true })
    await writeFile(join(root, owner, '个人文件/阶段/验收.txt'), '个人')
    await writeFile(join(root, owner, '项目文件/2026/04/测试 #1/验收.md'), '项目')
    await writeFile(join(root, owner, 'workspace/custom/子目录/验收.txt'), '工作区')
    await writeFile(join(root, owner, 'trash/验收.txt'), '已删除')
    await writeFile(join(root, other, '个人文件/验收.txt'), '其他用户')
    await symlink(join(root, other, '个人文件'), join(root, owner, '个人文件/外部目录'))
    const queries: string[] = []
    let linked = false
    const pool = { async query(sql: string, bindings: unknown[]) {
      assert.equal(bindings.at(-1), owner)
      queries.push(sql)
      if (sql.includes('FROM projects')) return { rows: [{ id: 1, name: '测试', start_date: '2026-04-01' }] }
      if (sql.includes('FROM project_workspace_directories')) return { rows: linked ? [{ project_id: 1, directory_id: 2 }] : [] }
      assert.match(sql, /FROM workspace_directories/)
      return { rows: sql.includes('is_default') ? [] : [{ id: 2, name: '自建工作区', directory_name: 'custom' }] }
    } } as unknown as Parameters<typeof createDiskFileSearchSources>[0]
    const operations = createGlobalSearchOperations(createDiskFileSearchSources(pool, root))
    const result = await operations.search(owner, parseGlobalSearchQuery({ q: '验收', types: 'file' })) as {
      groups: Array<{ items: Array<{ path_file: { directoryId: string; relativePath: string; location: { kind: 'sandbox'; value: string } } }> }>
    }
    const paths = result.groups.flatMap(group => group.items.map(item => item.path_file))
    assert.deepEqual(paths.map(({ directoryId, relativePath }) => [directoryId, relativePath]).sort(), [
      [2, '子目录/验收.txt'],
      ['personal', '阶段/验收.txt'],
      ['project:1', '验收.md'],
    ])
    const nested = await operations.search(owner, parseGlobalSearchQuery({ q: '子目录/验收', types: 'file' })) as typeof result
    assert.deepEqual(nested.groups[0]?.items.map(item => item.path_file.relativePath), ['子目录/验收.txt'])
    assert.deepEqual(paths.map(item => item.location.value).sort(), [
      '/personal/阶段/验收.txt', '/project/2026/04/测试 #1/验收.md', '/workspace/custom/子目录/验收.txt',
    ])
    const exact = await operations.search(owner, {
      q: '/project/2026/04/测试 #1/验收.md', queries: ['/project/2026/04/测试 #1/验收.md'],
      mode: 'OR', perType: 6, types: ['file'],
    }) as typeof result
    assert.deepEqual(exact.groups[0]?.items.map(item => item.path_file.location.value), ['/project/2026/04/测试 #1/验收.md'])
    assert.equal(queries.length, 6)
    const projectFolder = await operations.search(owner, parseGlobalSearchQuery({ q: '测试', types: 'folder' })) as typeof result
    assert.deepEqual(projectFolder.groups[0]?.items.map(({ path_file }) => path_file.location.value),
      ['/project/2026/04/测试 #1'])
    linked = true
    const linkedFolder = await operations.search(owner, parseGlobalSearchQuery({ q: '测试', types: 'folder' })) as typeof result
    assert.deepEqual(linkedFolder.groups[0]?.items.map(({ path_file }) => path_file.location.value), ['/workspace/custom'])



    const browse = await operations.search(owner, parseGlobalSearchQuery({ types: ['file', 'folder'], per_type: '1' })) as typeof result
    assert.deepEqual(browse.groups.flatMap(group => group.items.map(item => item.path_file.location.value)).sort(),
      ['/personal/阶段', '/personal/阶段/验收.txt'])

    const folders = await operations.search(owner, parseGlobalSearchQuery({ q: '阶段', types: 'folder' })) as {
      groups: Array<{ items: Array<{ link: string }> }>
    }
    const references = createMindFileReferences(pool as Parameters<typeof createMindFileReferences>[0], root, true)
    const matches = await references(owner, '阶段', 6)
    const folder = matches.find(item => item.type === 'folder' && item.label === '阶段')
    assert.ok(folder)
    assert.equal(folders.groups[0]?.items[0]?.link, 'gugu://open-object/folder/' + folder.id)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
