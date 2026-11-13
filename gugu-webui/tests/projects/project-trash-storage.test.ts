import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ProjectRecord } from '@gugu/core'
import type { ProjectTrashFile, ProjectTrashFolder } from '../../src/domains/projects/application/project-trash.js'
import {
  createLocalProjectTrashStorage,
  createOssProjectTrashStorage,
  createProjectTrashOriginalStorageKeyResolver,
  projectFileTrashKey,
} from '../../src/domains/projects/persistence/project-trash-storage.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const originalKey = `${ownerId}/项目文件/2026/11/计划 #17/文档/计划.md`
const trashKey = `${ownerId}/trash/2026/11/计划 #17/文档/计划.md`
const project = {
  id: 17, user_id: ownerId, name: '计划', summary: null, client: null,
  status: 'pending', start_date: '2026-11-01', deadline: null,
  color: 'x', progress: 0, stages_json: '[]', current_stage: null,
  priority: null, version: 1, archived: false, done_at: null,
  created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', deleted_at: null,
} satisfies ProjectRecord
const file = {
  id: 41, user_id: ownerId, display_name: '计划', ext: 'md', space: 'project',
  project_id: 17, folder_id: 31, workspace_directory_id: null, stage_name: null,
  mind_map_id: null, storage_key: originalKey, version: 1, size: '8', size_bytes: 8,
  mime_type: 'text/markdown', img_width: null, img_height: null, deleted_at: null,
} satisfies ProjectTrashFile
const folders: ProjectTrashFolder[] = [{
  id: 31, user_id: ownerId, project_id: 17, workspace_directory_id: null,
  parent_id: null, name: '文档', version: 1, deleted_at: null,
}]

test('Local 项目文件物理移入回收站，再恢复时按 Python 规则解决同名冲突', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-project-trash-'))
  try {
    const source = path.join(root, originalKey)
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, '原始内容')
    const storage = createLocalProjectTrashStorage(root, () => originalKey)

    assert.equal(projectFileTrashKey(ownerId, file), trashKey)
    const moved = await storage.moveToTrash(ownerId, file)
    assert.equal(moved.storageKey, trashKey)
    assert.equal(await readFile(path.join(root, trashKey), 'utf8'), '原始内容')
    const mode = (await stat(path.join(root, trashKey))).mode & 0o777
    assert.equal(mode & 0o060, 0o060, '移动后的文件应保留 group rw 权限')

    const conflictingPath = path.join(root, originalKey)
    await mkdir(path.dirname(conflictingPath), { recursive: true })
    await writeFile(conflictingPath, '已有文件')
    const restored = await storage.restoreFromTrash(ownerId, { ...file, storage_key: trashKey }, project, folders)
    assert.equal(restored.storageKey, `${ownerId}/项目文件/2026/11/计划 #17/文档/计划(1).md`)
    assert.equal(restored.displayName, '计划(1)')
    assert.equal(await readFile(path.join(root, restored.storageKey), 'utf8'), '原始内容')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Local 存储 adapter 对 owner key 越界拒绝操作，缺失源文件返回预期恢复 key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-project-trash-safe-'))
  try {
    const storage = createLocalProjectTrashStorage(root, () => originalKey)
    await assert.rejects(storage.moveToTrash(ownerId, { ...file, storage_key: `${ownerId}/../outside.md` }))
    const restored = await storage.restoreFromTrash(ownerId, { ...file, storage_key: trashKey }, project, folders)
    assert.equal(restored.storageKey, originalKey)
    assert.equal(restored.displayName, '计划')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('OSS 项目软删保留原对象 key，常规恢复不调用对象搬运', async () => {
  let moves = 0
  const storage = createOssProjectTrashStorage(() => originalKey, async () => { moves += 1 })
  const moved = await storage.moveToTrash(ownerId, file)
  const restored = await storage.restoreFromTrash(ownerId, file, project, folders)
  assert.equal(moved.storageKey, originalKey)
  assert.equal(restored.storageKey, originalKey)
  assert.equal(moves, 0)
})

test('Python-compatible resolver owner-scopes MindMap metadata and follows its key layout', async () => {
  const calls: unknown[] = []
  const resolveKey = createProjectTrashOriginalStorageKeyResolver({
    async getOwnedProject(owner, id) {
      calls.push(['project', owner, id])
      return { name: '计划', startDate: '2026-11-01', createdAt: '2026-11-01T00:00:00.000Z' }
    },
    async getOwnedWorkspaceDirectory(owner, id) {
      calls.push(['workspace', owner, id])
      return null
    },
    async getOwnedMindMap(owner, id) {
      calls.push(['mind', owner, id])
      return { title: '路线图' }
    },
    async resolveOwnedFolderPath(owner, folderId, projectId, workspaceDirectoryId) {
      calls.push(['folder', owner, folderId, projectId, workspaceDirectoryId])
      return '设计/评审'
    },
  })
  const key = await resolveKey(ownerId, {
    ...file, space: 'mind', project_id: 17, folder_id: 31, mind_map_id: 9,
  }, project, folders)
  assert.equal(key, `${ownerId}/思维/路线图 #9/计划.md`)
  assert.deepEqual(calls, [
    ['project', ownerId, 17],
    ['folder', ownerId, 31, 17, null],
    ['mind', ownerId, 9],
  ])
})

test('workspace restore uses stable directory_name and rejects missing or deleted owner directory', async () => {
  const resolveKey = createProjectTrashOriginalStorageKeyResolver({
    async getOwnedProject() { return null },
    async getOwnedWorkspaceDirectory(owner, id) {
      assert.equal(owner, ownerId)
      assert.equal(id, 27)
      return { directoryName: 'workspace-f1-data', deletedAt: null }
    },
    async getOwnedMindMap() { return null },
    async resolveOwnedFolderPath(owner, folderId, projectId, workspaceDirectoryId) {
      assert.deepEqual([owner, folderId, projectId, workspaceDirectoryId], [ownerId, 31, null, 27])
      return '资料/会议'
    },
  })
  const key = await resolveKey(ownerId, {
    ...file, space: 'workspace', project_id: null, folder_id: 31,
    workspace_directory_id: 27, mind_map_id: null,
  }, project, folders)
  assert.equal(key, `${ownerId}/workspace/workspace-f1-data/资料/会议/计划.md`)

  for (const directory of [null, { directoryName: 'workspace-old', deletedAt: '2026-11-01T00:00:00Z' }]) {
    const missing = createProjectTrashOriginalStorageKeyResolver({
      async getOwnedProject() { return null },
      async getOwnedWorkspaceDirectory() { return directory },
      async getOwnedMindMap() { return null },
      async resolveOwnedFolderPath() { return null },
    })
    await assert.rejects(async () => missing(ownerId, {
      ...file, space: 'workspace', project_id: null, folder_id: null,
      workspace_directory_id: 27, mind_map_id: null,
    }, project, []), /工作区目录不存在/)
  }
})

test('Python-compatible resolver matches missing MindMap and invalid folder fallbacks', async () => {
  const resolveKey = createProjectTrashOriginalStorageKeyResolver({
    async getOwnedProject() { return null },
    async getOwnedWorkspaceDirectory() { return null },
    async getOwnedMindMap() { return null },
    async resolveOwnedFolderPath() { return null },
  })
  const key = await resolveKey(ownerId, {
    ...file, space: 'mind', project_id: null, folder_id: 999, mind_map_id: 9,
  }, project, [])
  assert.equal(key, `${ownerId}/思维/ #9/计划.md`)
})

test('Local restore rejects a symlinked metadata target instead of swallowing the unsafe path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-project-trash-link-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'gugu-project-trash-outside-'))
  try {
    const ownerRoot = path.join(root, ownerId)
    await mkdir(ownerRoot, { recursive: true })
    await symlink(outside, path.join(ownerRoot, '思维'))
    const storage = createLocalProjectTrashStorage(root, () => `${ownerId}/思维/路线图 #9/note.md`)
    await assert.rejects(
      storage.restoreFromTrash(ownerId, { ...file, space: 'mind', storage_key: `${ownerId}/trash/note.md` }, project, []),
      { name: 'ProjectTrashStoragePathError' },
    )
    assert.deepEqual(await readFile(path.join(outside, '路线图 #9', 'note.md')).catch(() => null), null)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
