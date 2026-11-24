import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostgresProjectTrashPathMetadataReader } from '../../src/modules/projects/lifecycle/storage.js'

const ownerId = '00000000-0000-4000-8000-000000000041'

test('project trash metadata reader scopes all lookups to the owner and returns Python key inputs', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const reader = createPostgresProjectTrashPathMetadataReader({
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values })
      if (sql.includes('FROM projects')) return { rows: [{ name: '项目', start_date: null, created_at: '2026-01-02T03:04:05.000Z' }] }
      if (sql.includes('FROM workspace_directories')) return { rows: [{ directory_name: 'workspace-q1', deleted_at: null }] }
      if (sql.includes('FROM mind_maps')) return { rows: [{ title: '思维图' }] }
      return { rows: [] }
    },
  } as never)

  assert.deepEqual(await reader.getOwnedProject(ownerId, 17), {
    name: '项目', startDate: null, createdAt: '2026-01-02T03:04:05.000Z',
  })
  assert.deepEqual(await reader.getOwnedWorkspaceDirectory(ownerId, 27), {
    directoryName: 'workspace-q1', deletedAt: null,
  })
  assert.deepEqual(await reader.getOwnedMindMap(ownerId, 9), { title: '思维图' })
  assert.deepEqual(calls.map((call) => call.values), [
    [17, ownerId], [27, ownerId], [9, ownerId],
  ])
})
