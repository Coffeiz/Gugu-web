import assert from 'node:assert/strict'
import { link, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { purgeExpiredProject, recoverProjectExpiryJournal } from '../../src/modules/projects/persistence/project-expiry-postgres.js'

test('过期项目清理限定 owner，删除文件并在事务中更新配额', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-expiry-'))
  const owner = '00000000-0000-0000-0000-000000000001'
  await mkdir(path.join(root, owner, 'trash'), { recursive: true })
  await writeFile(path.join(root, owner, 'trash', 'a'), 'abc')
  const calls: { sql: string; args: unknown[] }[] = []
  const client = {
    async query(sql: string, args: unknown[] = []) {
      calls.push({ sql, args })
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
      if (sql.includes('FROM projects WHERE deleted_at')) return { rows: [{ id: 7, user_id: owner }], rowCount: 1 }
      if (sql.includes('SELECT id,storage_key FROM files')) return { rows: [{ id: 9, storage_key: `${owner}/trash/a` }], rowCount: 1 }
      if (sql.includes('SELECT storage_limit_bytes')) return { rows: [{ storage_limit_bytes: null }], rowCount: 1 }
      if (sql.includes('SELECT used_bytes')) return { rows: [{ used_bytes: 3 }], rowCount: 1 }
      if (sql.includes('DELETE FROM scheduled_tasks')) return { rows: [{ id: 16 }, { id: 17 }], rowCount: 2 }
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }
  try {
    assert.equal(await purgeExpiredProject({ connect: async () => client, query: async () => ({ rows: [] }) } as unknown as Pool, root, new Date(), null), true)
    await assert.rejects(readFile(path.join(root, owner, 'trash', 'a')))
    assert.ok(calls.some(({ sql, args }) => sql.includes('DELETE FROM projects') && args[0] === owner && args[1] === 7))
    assert.deepEqual(calls.filter(({ sql }) => sql.includes('INSERT INTO rag_index_jobs')).map(({ args }) => args), [[owner, '16'], [owner, '17']])
    assert.ok(calls.some(({ sql, args }) => sql.includes('INSERT INTO storage_quota_ledgers') && args[0] === owner))
    assert.ok(calls.some(({ sql }) => sql === 'COMMIT'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('拒绝越权存储 key 时回滚事务并保留其他用户文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-expiry-'))
  const owner = '00000000-0000-0000-0000-000000000001'
  const other = '00000000-0000-0000-0000-000000000002'
  await mkdir(path.join(root, other), { recursive: true })
  await writeFile(path.join(root, other, 'a'), '保留')
  const calls: string[] = []
  const client = {
    async query(sql: string) {
      calls.push(sql)
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
      if (sql.includes('FROM projects WHERE deleted_at')) return { rows: [{ id: 7, user_id: owner }] }
      if (sql.includes('SELECT id,storage_key FROM files')) return { rows: [{ id: 9, storage_key: `${other}/a` }] }
      if (sql.includes('SELECT storage_limit_bytes')) return { rows: [{ storage_limit_bytes: null }], rowCount: 1 }
      if (sql.includes('SELECT used_bytes')) return { rows: [{ used_bytes: 3 }] }
      return { rows: [] }
    },
    release() {},
  }
  try {
    await assert.rejects(purgeExpiredProject({ connect: async () => client, query: async () => ({ rows: [] }) } as unknown as Pool, root, new Date(), null))
    assert.equal(await readFile(path.join(root, other, 'a'), 'utf8'), '保留')
    assert.ok(calls.includes('ROLLBACK'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('数据库写入失败时恢复已暂存文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-expiry-'))
  const owner = '00000000-0000-0000-0000-000000000001'
  await mkdir(path.join(root, owner, 'trash'), { recursive: true })
  const file = path.join(root, owner, 'trash', 'a')
  await writeFile(file, '原文件')
  const client = {
    async query(sql: string) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
      if (sql.includes('FROM projects WHERE deleted_at')) return { rows: [{ id: 7, user_id: owner }] }
      if (sql.includes('SELECT id,storage_key FROM files')) return { rows: [{ id: 9, storage_key: `${owner}/trash/a` }] }
      if (sql.includes('SELECT storage_limit_bytes')) return { rows: [{ storage_limit_bytes: null }], rowCount: 1 }
      if (sql.includes('SELECT used_bytes')) return { rows: [{ used_bytes: 9 }] }
      if (sql.includes('DELETE FROM files')) throw new Error('数据库故障')
      return { rows: [] }
    },
    release() {},
  }
  try {
    await assert.rejects(purgeExpiredProject({ connect: async () => client, query: async () => ({ rows: [] }) } as unknown as Pool, root, new Date(), null))
    assert.equal(await readFile(file, 'utf8'), '原文件')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('提交结果未知时保留暂存文件，避免误判回滚而覆盖后续文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-expiry-'))
  const owner = '00000000-0000-0000-0000-000000000001'
  const directory = path.join(root, owner, 'trash')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'a'), '原文件')
  const client = {
    async query(sql: string) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
      if (sql.includes('FROM projects WHERE deleted_at')) return { rows: [{ id: 7, user_id: owner }] }
      if (sql.includes('SELECT id,storage_key FROM files')) return { rows: [{ id: 9, storage_key: `${owner}/trash/a` }] }
      if (sql.includes('SELECT storage_limit_bytes')) return { rows: [{ storage_limit_bytes: null }], rowCount: 1 }
      if (sql.includes('SELECT used_bytes')) return { rows: [{ used_bytes: 9 }] }
      if (sql === 'COMMIT') throw new Error('连接中断')
      return { rows: [] }
    },
    release() {},
  }
  try {
    await assert.rejects(purgeExpiredProject({ connect: async () => client, query: async () => ({ rows: [] }) } as unknown as Pool, root, new Date(), null))
    const entries = await readdir(directory)
    assert.equal(entries.length, 1)
    assert.notEqual(entries[0], 'a')
    assert.equal(await readFile(path.join(directory, entries[0]!), 'utf8'), '原文件')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('恢复日志在项目仍存在时恢复暂存文件，并拒绝覆盖新文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-expiry-recover-'))
  const owner = '00000000-0000-0000-0000-000000000001'
  const journalId = '00000000-0000-4000-8000-000000000001'
  const directory = path.join(root, owner, 'trash')
  const original = path.join(directory, 'a')
  const staged = `${original}.gugu-purge-${journalId}`
  await mkdir(directory, { recursive: true })
  await writeFile(staged, '旧文件')
  const client = {
    async query(sql: string) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
      if (sql.includes('FROM project_expiry_journals')) return { rows: [{ id: journalId, user_id: owner, project_id: 7, entries: [{ id: 9, storage_key: `${owner}/trash/a` }] }] }
      if (sql.includes('FROM projects')) return { rows: [{ id: 7 }], rowCount: 1 }
      if (sql.includes('FROM files')) return { rows: [{ storage_key: `${owner}/trash/a` }], rowCount: 1 }
      return { rows: [] }
    },
    release() {},
  }
  const pool = { connect: async () => client } as unknown as Pool
  try {
    await writeFile(original, '新文件')
    await assert.rejects(recoverProjectExpiryJournal(pool, root))
    assert.equal(await readFile(original, 'utf8'), '新文件')
    assert.equal(await readFile(staged, 'utf8'), '旧文件')
    await rm(original)
    assert.equal(await recoverProjectExpiryJournal(pool, root), true)
    assert.equal(await readFile(original, 'utf8'), '旧文件')
    // 模拟 link 已成功、暂存链接尚未删除时进程退出。
    await link(original, staged)
    assert.equal(await recoverProjectExpiryJournal(pool, root), true)
    assert.equal(await readFile(original, 'utf8'), '旧文件')
    await assert.rejects(readFile(staged))
  } finally { await rm(root, { recursive: true, force: true }) }
})
