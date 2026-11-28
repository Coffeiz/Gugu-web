import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { purgeExpiredProject, recoverProjectExpiryJournal } from '../../src/modules/projects/lifecycle/expiry.js'
import { projectTrashDirectoryKey } from '../../src/modules/projects/lifecycle/storage.js'

const owner = '00000000-0000-0000-0000-000000000001'
const journalId = '00000000-0000-4000-8000-000000000001'
const project = { id: 7, user_id: owner, name: '测试项目', start_date: null, created_at: '2026-01-01' }

for (const mode of ['success', 'rollback', 'unknown'] as const) {
  test(`项目路径清理：${mode}`, { skip: process.platform !== 'linux' }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gugu-expiry-'))
    const source = path.join(root, projectTrashDirectoryKey(owner, 7))
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'a'), '原文件')
    const client = {
      async query(sql: string) {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
        if (sql.includes('FROM projects WHERE deleted_at')) return { rows: [project] }
        if (sql.includes('DELETE FROM scheduled_tasks')) {
          if (mode === 'rollback') throw new Error('数据库故障')
          return { rows: [] }
        }
        if (sql === 'COMMIT' && mode === 'unknown') throw new Error('连接中断')
        return { rows: [] }
      }, release() {},
    }
    const pool = { connect: async () => client } as unknown as Pool
    try {
      if (mode === 'success') {
        assert.equal(await purgeExpiredProject(pool, root, new Date()), true)
        await assert.rejects(readFile(path.join(source, 'a')))
      } else if (mode === 'rollback') {
        await assert.rejects(purgeExpiredProject(pool, root, new Date()))
        assert.equal(await readFile(path.join(source, 'a'), 'utf8'), '原文件')
      } else {
        await assert.rejects(purgeExpiredProject(pool, root, new Date()))
        await assert.rejects(readFile(path.join(source, 'a')))
        const staging = path.join(root, owner, '.gugu-project-purge')
        const entries = await readdir(staging)
        assert.equal(entries.length, 1)
        assert.equal(await readFile(path.join(staging, entries[0]!, 'a'), 'utf8'), '原文件')
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

test('恢复日志拒绝覆盖已有项目目录，冲突解除后恢复暂存目录', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-expiry-recover-'))
  const key = projectTrashDirectoryKey(owner, 7)
  const original = path.join(root, key)
  const staged = path.join(root, owner, '.gugu-project-purge', journalId)
  await mkdir(original, { recursive: true })
  await mkdir(staged, { recursive: true })
  await writeFile(path.join(original, 'a'), '新文件')
  await writeFile(path.join(staged, 'a'), '旧文件')
  const client = {
    async query(sql: string) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
      if (sql.includes('FROM project_expiry_journals')) return { rows: [{ id: journalId, user_id: owner, project_id: 7, entries: { source: key } }] }
      if (sql.includes('FROM projects')) return { rows: [project] }
      return { rows: [] }
    }, release() {},
  }
  const pool = { connect: async () => client } as unknown as Pool
  try {
    await assert.rejects(recoverProjectExpiryJournal(pool, root))
    assert.equal(await readFile(path.join(original, 'a'), 'utf8'), '新文件')
    assert.equal(await readFile(path.join(staged, 'a'), 'utf8'), '旧文件')
    await rm(original, { recursive: true })
    assert.equal(await recoverProjectExpiryJournal(pool, root), true)
    assert.equal(await readFile(path.join(original, 'a'), 'utf8'), '旧文件')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('恢复日志拒绝跨用户路径', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-expiry-owner-'))
  const other = '00000000-0000-0000-0000-000000000002'
  const file = path.join(root, other, 'a')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, '保留')
  const client = {
    async query(sql: string) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
      if (sql.includes('FROM project_expiry_journals')) return { rows: [{ id: journalId, user_id: owner, project_id: 7, entries: { source: `${other}/a` } }] }
      return { rows: [] }
    }, release() {},
  }
  try {
    await assert.rejects(recoverProjectExpiryJournal({ connect: async () => client } as unknown as Pool, root))
    assert.equal(await readFile(file, 'utf8'), '保留')
  } finally { await rm(root, { recursive: true, force: true }) }
})
