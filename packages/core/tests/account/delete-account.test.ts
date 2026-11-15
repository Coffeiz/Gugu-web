import { describe, expect, it } from 'vitest'
import { createAccountDeleter } from '../../src/account/delete-account.js'

const owner = '00000000-0000-4000-8000-000000000071'

describe('账号注销用例', () => {
it('先清理缓存与存储，再删除数据库用户并发布失效事件', async () => {
  const calls: string[] = []
  const deleteAccount = createAccountDeleter({
    async readOwnedFileIds(id) { calls.push(`files:${id}`); return [3, 9] },
    async removeThumbnails(id, fileIds) { calls.push(`thumbnails:${id}:${fileIds.join(',')}`) },
    async removeStoragePrefixes(id) { calls.push(`storage:${id}`); return 4 },
    async clearEphemeralData(id) { calls.push(`ephemeral:${id}`) },
    async deleteDatabaseUser(id) { calls.push(`delete:${id}`); return true },
    async publishAuthStateChanged(id) { calls.push(`auth:${id}`) },
    onStorageCleanupFailure() { calls.push('storage-error') },
  })

  expect(await deleteAccount(owner.toUpperCase())).toBe(4)
  expect(calls).toEqual([
    `files:${owner}`, `thumbnails:${owner}:3,9`, `storage:${owner}`,
    `ephemeral:${owner}`, `delete:${owner}`, `auth:${owner}`,
  ])
})

it('存储删除失败仍删除数据库用户并以 -1 反映失败', async () => {
  const calls: string[] = []
  const deleteAccount = createAccountDeleter({
    async readOwnedFileIds() { return [] },
    async removeThumbnails() {},
    async removeStoragePrefixes() { throw new Error('storage unavailable') },
    async clearEphemeralData() { calls.push('ephemeral') },
    async deleteDatabaseUser() { calls.push('delete'); return true },
    async publishAuthStateChanged() { calls.push('auth') },
    onStorageCleanupFailure() { calls.push('storage-error') },
  })

  expect(await deleteAccount(owner)).toBe(-1)
  expect(calls).toEqual(['storage-error', 'ephemeral', 'delete', 'auth'])
})

it('缩略图清理失败时不删除用户，避免遗留共享目录缓存', async () => {
  let deleted = false
  const deleteAccount = createAccountDeleter({
    async readOwnedFileIds() { return [3] },
    async removeThumbnails() { throw new Error('cache unavailable') },
    async removeStoragePrefixes() { return 0 },
    async clearEphemeralData() {},
    async deleteDatabaseUser() { deleted = true; return true },
    async publishAuthStateChanged() {},
    onStorageCleanupFailure() {},
  })

  await expect(deleteAccount(owner)).rejects.toThrow('cache unavailable')
  expect(deleted).toBe(false)
})

it('已不存在的用户不会触发任何清理副作用', async () => {
  const deleteAccount = createAccountDeleter({
    async readOwnedFileIds() { return null },
    async removeThumbnails() { throw new Error('不应清理缩略图') },
    async removeStoragePrefixes() { throw new Error('不应清理存储') },
    async clearEphemeralData() { throw new Error('不应清理临时数据') },
    async deleteDatabaseUser() { throw new Error('不应删除数据库用户') },
    async publishAuthStateChanged() { throw new Error('不应发布事件') },
    onStorageCleanupFailure() {},
  })

  await expect(deleteAccount(owner)).rejects.toMatchObject({ code: 'not_found' })
})
})
