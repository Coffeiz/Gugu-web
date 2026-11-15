import assert from 'node:assert/strict'
import test from 'node:test'
import { planFolderSoftDelete } from '../../../../packages/core/src/files/folder-delete.js'

const owner = '00000000-0000-4000-8000-000000000041'

test('folder soft-delete plan includes the live owned subtree and leaves independently trashed rows alone', () => {
  const plan = planFolderSoftDelete(owner, 10, [
    { id: 10, user_id: owner, parent_id: null, deleted_at: null },
    { id: 11, user_id: owner, parent_id: 10, deleted_at: null },
    { id: 12, user_id: owner, parent_id: 11, deleted_at: null },
    { id: 13, user_id: owner, parent_id: 10, deleted_at: '2026-01-01T00:00:00Z' },
    { id: 14, user_id: '00000000-0000-4000-8000-000000000099', parent_id: 10, deleted_at: null },
  ], [
    { id: 21, user_id: owner, folder_id: 10, deleted_at: null },
    { id: 22, user_id: owner, folder_id: 11, deleted_at: null },
    { id: 23, user_id: owner, folder_id: 12, deleted_at: '2026-01-02T00:00:00Z' },
    { id: 24, user_id: owner, folder_id: 13, deleted_at: null },
    { id: 25, user_id: '00000000-0000-4000-8000-000000000099', folder_id: 14, deleted_at: null },
  ])
  assert.deepEqual(plan.folderIds, [10, 11, 12])
  assert.deepEqual(plan.fileIds, [21, 22])
})

test('folder soft-delete plan reports a missing or foreign root as not found', () => {
  assert.throws(() => planFolderSoftDelete(owner, 10, [
    { id: 10, user_id: '00000000-0000-4000-8000-000000000099', parent_id: null, deleted_at: null },
  ], []), { code: 'not_found' })
})
