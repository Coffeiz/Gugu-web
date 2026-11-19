import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { sql } from 'kysely'
import { dataContext, createProjectGetter } from '@gugu/core'
import { initializeSqlite, openSqliteRuntime, projectRecord, databaseTime } from '@gugu/core/data'
import { createProjectTrashService, type ProjectTrashFile, type ProjectTrashStorage, type ProjectTrashTransaction } from '@gugu/core/project-trash'
import { projectFileTrashKey } from '@gugu/core/project-file-paths'
import { applyProjectUndo, type ProjectUndoTransaction } from '@gugu/core/projects/undo'
import { createKyselyProjectFileCountReader } from '@gugu/core/project-read-data'
import { createRuntimeUndoTransactionPort, createUndoStateMachine } from '@gugu/core/undo'
import { createLocalProjectTrashStorage } from '../../src/modules/projects/lifecycle/storage.js'

test('Core 项目恢复/Undo 经过临时 SQLite 与真实 Host 文件端口，冲突改名、同批恢复、计数和提交失败补偿一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-project-core-')), path = join(root, 'core.db')
  await initializeSqlite(path)
  const { runtime, ownerId: owner } = await openSqliteRuntime(path)
  const context = dataContext(owner), key = owner.replaceAll('-', ''), events: unknown[] = []
  const diskStorage = createLocalProjectTrashStorage(root)
  let conflictMove: 'delete' | 'restore' | null = null, conflictPath = '', rollbackConflict = false
  function gate(direction: 'delete' | 'restore', before?: (from: string, to: string) => Promise<void>) {
    if (!before && conflictMove !== direction) return undefined
    return async (from: string, to: string) => {
      await before?.(from, to)
      if (conflictMove === direction) { conflictPath = to; await writeFile(join(root, to), '并发目标', { flag: 'wx' }) }
    }
  }
  const storage: ProjectTrashStorage = {
    moveToTrash: (user, item, before) => diskStorage.moveToTrash(user, item, gate('delete', before)),
    restoreFromTrash: (user, item, project, folders, before) => diskStorage.restoreFromTrash(user, item, project, folders, gate('restore', before)),
  }
  // 仅测试夹具投影：按路径保存旧模型快照，不给正式 SQLite 新建旧文件对象表。
  // 实际业务项目与 Undo 使用正式表；正式文件索引/授权根仍是单独的 Host 迁移事项。
  try {
    await sql`CREATE TABLE fixture_project_files(path TEXT PRIMARY KEY,payload TEXT NOT NULL)`.execute(runtime.db)
    await sql`CREATE TABLE project_file_counts(project_id INTEGER PRIMARY KEY,file_count INTEGER NOT NULL CHECK(file_count>0))`.execute(runtime.db)
    const project = await runtime.transaction(context, data => data.projects.create({ name: '恢复项目', start_date: '2026-11-01' }))
    const originalPath = `${owner}/项目文件/2026/11/恢复项目 #${project.id}/计划.md`
    const file: ProjectTrashFile = { id: 41, user_id: owner, display_name: '计划', ext: 'md', space: 'project',
      project_id: project.id, folder_id: null, workspace_directory_id: null, stage_name: null, mind_map_id: null,
      storage_key: originalPath, version: 1, size: '6B', size_bytes: 6, mime_type: 'text/markdown', img_width: null, img_height: null, deleted_at: null }
    const older = { ...file, id: 42, display_name: '旧删除', storage_key: `${owner}/trash/旧删除.md`, deleted_at: '2026-01-01T00:00:00Z' }
    for (const item of [file, older]) await sql`INSERT INTO fixture_project_files VALUES (${item.storage_key},${JSON.stringify(item)})`.execute(runtime.db)
    await mkdir(dirname(join(root, originalPath)), { recursive: true })
    await writeFile(join(root, originalPath), '原始内容')
    let failCommit = false, operationId = ''
    const readFiles = async () => (await sql<{ payload: string }>`SELECT payload FROM fixture_project_files`.execute(runtime.db)).rows.map(row => JSON.parse(row.payload) as ProjectTrashFile)
    const readCurrent = async () => (await readFiles()).find(row => row.id === file.id)!
    type Session = Parameters<Parameters<ReturnType<typeof runtime.db.transaction>['execute']>[0]>[0]
    const getProject = async (tx: Session, user: string, id: number) => {
      const row = await tx.selectFrom('projects').selectAll().where('id', '=', id).where('user_id', '=', user.replaceAll('-', '')).executeTakeFirst()
      return row ? projectRecord(row) : null
    }
    const updateFile = async (tx: Session, item: ProjectTrashFile) => {
      await sql`UPDATE fixture_project_files SET path=${item.storage_key},payload=${JSON.stringify(item)} WHERE json_extract(payload,'$.id')=${item.id} AND json_extract(payload,'$.user_id')=${owner}`.execute(tx)
      await sql`DELETE FROM project_file_counts WHERE project_id=${project.id}`.execute(tx)
      await sql`INSERT INTO project_file_counts SELECT ${project.id},count(*) FROM fixture_project_files
        WHERE json_extract(payload,'$.user_id')=${owner} AND json_extract(payload,'$.project_id')=${project.id}
        AND json_extract(payload,'$.folder_id') IS NULL AND json_extract(payload,'$.space')='project' AND json_extract(payload,'$.deleted_at') IS NULL HAVING count(*)>0`.execute(tx)
    }
    const transaction = async <T>(work: (tx: ProjectTrashTransaction) => Promise<T>) => runtime.db.transaction().execute(async tx => {
      const result = await work({
        getOwnedProject: (user, id) => getProject(tx, user, id),
        async listProjectResources(user, id, deletedAt) {
          const rows = (await sql<{ payload: string }>`SELECT payload FROM fixture_project_files`.execute(tx)).rows.map(row => JSON.parse(row.payload) as ProjectTrashFile)
          return { files: rows.filter(row => row.user_id === user && row.project_id === id && (deletedAt === undefined ? row.deleted_at === null : row.deleted_at !== null && databaseTime(row.deleted_at, 'sqlite') === databaseTime(deletedAt, 'sqlite'))), folders: [], events: [], tasks: [] }
        },
        async updateProject(user, id, fields) {
          await tx.updateTable('projects').set({ ...fields, deleted_at: fields.deleted_at === null ? null : databaseTime(fields.deleted_at, 'sqlite') }).where('id', '=', id).where('user_id', '=', user.replaceAll('-', '')).execute()
          return (await getProject(tx, user, id))!
        },
        async updateFile(user, item) { assert.equal(user, owner); await updateFile(tx, item) },
        async updateFolder() { assert.fail('本夹具没有目录记录') }, async updateEvent() { assert.fail('本夹具没有活动') }, async updateTask() { assert.fail('本夹具没有任务') },
        async recordUndo(record) {
          operationId = randomUUID()
          const now = new Date().toISOString(), expires = new Date(Date.now() + 86_400_000).toISOString()
          await tx.insertInto('undo_operations').values({ id: operationId, user_id: key, undo_context_id: record.contextId,
            group_id: operationId, resource: record.resource, action: record.action, target_refs: JSON.stringify(record.targetRefs),
            before_state: JSON.stringify(record.beforeState), after_state: JSON.stringify(record.afterState), base_versions: JSON.stringify(record.baseVersions),
            artifact_refs: '{}', actor_type: 'web', status: 'active', created_at: databaseTime(now, 'sqlite'), expires_at: databaseTime(expires, 'sqlite'), undone_at: null, failure_code: null }).execute()
        },
      })
      if (failCommit) {
        if (rollbackConflict) await writeFile(join(root, originalPath), '回滚位置的新文件', { flag: 'wx' })
        throw new Error('合成提交前故障')
      }
      return result
    })
    const counts = createKyselyProjectFileCountReader(runtime.db, 'sqlite')
    const service = createProjectTrashService({ transaction, async getProjectFileCount(user, id) { return (await counts.forProjects(user, [id])).get(id) ?? 0 }, async publishResourceChanged(event) { events.push(event) } }, storage)
    await assert.rejects(service.deleteProject(randomUUID(), project.id), { code: 'not_found' })
    failCommit = true
    await assert.rejects(service.deleteProject(owner, project.id), /合成提交前故障/)
    assert.equal(await readFile(join(root, originalPath), 'utf8'), '原始内容')
    assert.equal((await readCurrent()).deleted_at, null)
    assert.equal((await getProject(runtime.db as unknown as Session, owner, project.id))!.version, 1)
    assert.equal(events.length, 0)
    failCommit = false
    // 删除目标在预检查后才出现：安全错误必须穿过 Python 兼容 catch，回滚所有数据库写入。
    conflictMove = 'delete'
    await assert.rejects(service.deleteProject(owner, project.id), { code: 'EEXIST' })
    assert.equal((await readCurrent()).deleted_at, null)
    assert.equal((await getProject(runtime.db as unknown as Session, owner, project.id))!.version, 1)
    assert.equal(events.length, 0)
    assert.equal(await readFile(join(root, originalPath), 'utf8'), '原始内容')
    assert.equal(await readFile(join(root, conflictPath), 'utf8'), '并发目标')
    await unlink(join(root, conflictPath))
    conflictMove = null
    // 提交失败后补偿目标被占：事务仍回滚，磁盘两边均保留并报告 busy，不能覆盖新文件。
    failCommit = true; rollbackConflict = true
    await assert.rejects(service.deleteProject(owner, project.id), { code: 'busy' })
    const trashPath = projectFileTrashKey(owner, file)
    assert.equal(await readFile(join(root, originalPath), 'utf8'), '回滚位置的新文件')
    assert.equal(await readFile(join(root, trashPath), 'utf8'), '原始内容')
    assert.equal((await readCurrent()).deleted_at, null)
    assert.equal((await getProject(runtime.db as unknown as Session, owner, project.id))!.version, 1)
    assert.equal(events.length, 0)
    await unlink(join(root, originalPath))
    await diskStorage.restoreFromTrash(owner, { ...file, storage_key: trashPath }, project, [])
    failCommit = false; rollbackConflict = false
    await service.deleteProject(owner, project.id, { undoContextId: 'project-test' })
    const deletedFile = await readCurrent()
    assert.equal(await readFile(join(root, deletedFile.storage_key), 'utf8'), '原始内容')
    assert.deepEqual(await counts.list(owner), [{ projectId: project.id, fileCount: 0 }])
    assert.deepEqual((await readFiles()).find(row => row.id === older.id), older)
    conflictMove = 'restore'
    const deletedProject = await getProject(runtime.db as unknown as Session, owner, project.id), eventCount = events.length
    await assert.rejects(service.restoreProject(owner, project.id), { code: 'EEXIST' })
    assert.deepEqual(await getProject(runtime.db as unknown as Session, owner, project.id), deletedProject)
    assert.deepEqual(await readCurrent(), deletedFile)
    assert.equal(events.length, eventCount)
    assert.equal(await readFile(join(root, deletedFile.storage_key), 'utf8'), '原始内容')
    assert.equal(await readFile(join(root, conflictPath), 'utf8'), '并发目标')
    await unlink(join(root, conflictPath))
    conflictMove = null
    await writeFile(join(root, originalPath), '保留重名文件')
    const restored = await service.restoreProject(owner, project.id)
    assert.equal(restored.fileCount, 1)
    assert.equal((await readCurrent()).display_name, '计划(1)')
    assert.equal(await readFile(join(root, originalPath), 'utf8'), '保留重名文件')
    assert.equal(await readFile(join(root, (await readCurrent()).storage_key), 'utf8'), '原始内容')
    assert.equal((await createProjectGetter(runtime, counts)(owner, project.id))!.fileCount, 1)
    // 手动恢复已经改变版本，旧删除操作的 Undo 必须在移动任何文件前拒绝。
    const rollback: Array<() => Promise<void>> = []
    const engine = createUndoStateMachine(createRuntimeUndoTransactionPort(runtime), async () => {}, undefined, {
      projects: { async apply({ tx, row, mode }) {
        const store: ProjectUndoTransaction = {
          async getOwned(kind, id, user) {
            if (kind === 'project') { const value = await getProject(tx as Session, user, id); return value ? { ...value, contact_name: value.client } : null }
            if (kind === 'file') return (await sql<{ payload: string }>`SELECT payload FROM fixture_project_files WHERE json_extract(payload,'$.id')=${id} AND json_extract(payload,'$.user_id')=${user}`.execute(tx)).rows.map(value => JSON.parse(value.payload))[0] ?? null
            return null
          },
          async update(kind, id, user, fields) {
            if (kind === 'project') { await tx.updateTable('projects').set({ deleted_at: fields.deleted_at == null ? null : databaseTime(String(fields.deleted_at), 'sqlite'), version: sql<number>`version+1` }).where('id', '=', id).where('user_id', '=', key).execute(); return store.getOwned(kind, id, user) }
            if (kind === 'file') { const current = await store.getOwned(kind, id, user); await updateFile(tx as Session, { ...current, ...fields, version: Number(current!.version) + 1 } as ProjectTrashFile); return store.getOwned(kind, id, user) }
            throw new Error('不支持的夹具资源')
          }, async renameFilePrefixes() { assert.fail('本用例没有项目改名') },
        }
        return applyProjectUndo(store, owner, { id: row.id, action: row.action, before_state: JSON.parse(String(row.before_state)), after_state: JSON.parse(String(row.after_state)) }, mode, { trash: storage, async renameDirectory() { assert.fail('本用例没有目录改名') } }, rollback)
      } },
    })
    await assert.rejects(engine.apply(owner, 'project-test', operationId, 'undo'), { code: 'undo.conflict' })
    assert.equal(rollback.length, 0)
    await service.deleteProject(owner, project.id, { undoContextId: 'project-test-2' })
    const undoId = operationId
    const undoSnapshot = async () => ({
      project: await getProject(runtime.db as unknown as Session, owner, project.id), file: await readCurrent(),
      operation: await runtime.db.selectFrom('undo_operations').selectAll().where('id', '=', undoId).executeTakeFirstOrThrow(),
    })
    // Undo 已先修改项目行；文件冲突必须使整笔 SQLite 事务回滚，终态也不能提前变更。
    const beforeUndo = await undoSnapshot()
    conflictMove = 'restore'
    await assert.rejects(engine.apply(owner, 'project-test-2', undoId, 'undo'), { code: 'EEXIST' })
    assert.deepEqual(await undoSnapshot(), beforeUndo)
    assert.equal(await readFile(join(root, beforeUndo.file.storage_key), 'utf8'), '原始内容')
    assert.equal(await readFile(join(root, conflictPath), 'utf8'), '并发目标')
    await unlink(join(root, conflictPath)); conflictMove = null
    await engine.apply(owner, 'project-test-2', undoId, 'undo')
    assert.equal((await readCurrent()).deleted_at, null)
    const beforeRedo = await undoSnapshot()
    conflictMove = 'delete'
    await assert.rejects(engine.apply(owner, 'project-test-2', undoId, 'redo'), { code: 'EEXIST' })
    assert.deepEqual(await undoSnapshot(), beforeRedo)
    assert.equal(await readFile(join(root, beforeRedo.file.storage_key), 'utf8'), '原始内容')
    assert.equal(await readFile(join(root, conflictPath), 'utf8'), '并发目标')
    await unlink(join(root, conflictPath)); conflictMove = null
    await engine.apply(owner, 'project-test-2', undoId, 'redo')
    assert.ok((await readCurrent()).deleted_at)
    assert.equal(await readFile(join(root, (await readCurrent()).storage_key), 'utf8'), '原始内容')
    assert.deepEqual((await readFiles()).find(row => row.id === older.id), older)
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }) }
})
