import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'vitest'
import { createWorkspaceDeclarationCreator, createWorkspaceDeclarationUpdater } from '../../../src/workspaces/workspace-declarations.js'
import type { WorkspaceDeclaration, WorkspaceDeclarationRuntime } from '../../../src/workspaces/workspace-declarations.js'

const owner = randomUUID()
function fixture() {
  let row: WorkspaceDeclaration | null = null
  const relations = new Set([`${owner}:directory:7`, `${owner}:project:8`])
  let renames = 0
  const runtime: WorkspaceDeclarationRuntime = {
    async transaction(work) {
      let draft = row && { ...row }
      const result = await work({
        async relationExists(user, kind, id) { return relations.has(`${user}:${kind}:${id}`) },
        async insert(_user, fields) { draft = { ...fields, id: 1, isDefault: false, boundSessionCount: 0 }; return draft },
        async get(user) { return user === owner && draft ? { ...draft } : null },
        async renameDirectory(user, id, name) {
          if (user !== owner || id !== 7) throw new Error('关联目录不属于用户')
          renames++
          if (name === '冲突') throw new Error('Workspace 已存在')
          if (draft) draft.name = name
        },
        async update(_user, _id, fields) { if (draft) Object.assign(draft, fields) },
      })
      row = draft
      return result
    },
  }
  return { runtime, get row() { return row }, get renames() { return renames } }
}
test('工作区声明校验 owner 关联，并在同一事务更新目录显示名', async () => {
  const f = fixture(), create = createWorkspaceDeclarationCreator(f.runtime), update = createWorkspaceDeclarationUpdater(f.runtime)
  await assert.rejects(create(randomUUID(), { name: '工作区', kind: 'directory', directoryId: 7 }), { code: 'conflict' })
  assert.equal(Boolean(f.row), false)
  const created = await create(owner, { name: ' 工作区 ', kind: 'directory', directoryId: 7, projectId: 8 })
  assert.equal(created.name, '工作区')
  assert.equal(created.projectId, null)
  assert.equal((await update(owner, 1, { name: ' 新名称 ', enabled: false })).name, '新名称')
  assert.equal(f.row?.enabled, false)
  await assert.rejects(update(owner, 1, { name: '冲突', enabled: true }), /Workspace 已存在/)
  assert.equal(f.row?.name, '新名称')
  assert.equal(f.row?.enabled, false)
  await assert.rejects(update(randomUUID(), 1, { enabled: true }), { statusCode: 404 })
  assert.equal(f.renames, 2)
})
