import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Kysely, SqliteDialect } from 'kysely'
import SQLite from 'better-sqlite3'
import { expect, it } from 'vitest'
import { createSqliteTaskLease } from '@gugu/database/scheduled-tasks'

const exec = promisify(execFile)
it('SQLite 文件的独立进程竞争租约，过期旧 owner 无法续租或释放新租约', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-task-lease-'))
  const path = join(dir, 'db.sqlite')
  const native = new SQLite(path)
  native.pragma('journal_mode = WAL')
  native.pragma('busy_timeout = 5000')
  native.exec('CREATE TABLE scheduled_task_leases(task_id TEXT PRIMARY KEY,lease_owner TEXT NOT NULL,expires_at_ms INTEGER NOT NULL)')
  const db = new Kysely<{}>({ dialect: new SqliteDialect({ database: native }) })
  try {
    const child = `import { Kysely, SqliteDialect } from 'kysely'; import SQLite from 'better-sqlite3'; import { createSqliteTaskLease } from '@gugu/database/scheduled-tasks';
      const [path, owner] = process.argv.slice(1);
      const raw = new SQLite(path); raw.pragma('busy_timeout = 5000'); const db = new Kysely({dialect: new SqliteDialect({database: raw})});
      try { process.stdout.write(String(await createSqliteTaskLease(db, () => 1000).acquire('task', owner, 100))); } finally { await db.destroy(); }`
    const claims = await Promise.all(['a', 'b'].map(owner => exec(process.execPath, ['--input-type=module', '-e', child, path, owner])))
    expect(claims.map(result => result.stdout).sort()).toEqual(['false', 'true'])
    const winner = claims[0]!.stdout === 'true' ? 'a' : 'b'
    const other = winner === 'a' ? 'b' : 'a'
    let now = 1050
    const lease = createSqliteTaskLease(db, () => now)
    expect(await lease.isHeld('task')).toBe(true)
    expect(await lease.renew('task', other, 100)).toBe(false)
    expect(await lease.renew('task', winner, 100)).toBe(true)
    now = 1150
    expect(await lease.renew('task', winner, 100)).toBe(false)
    expect(await lease.acquire('task', other, 100)).toBe(true)
    await lease.release('task', winner)
    expect(await lease.isHeld('task')).toBe(true)
    expect(await lease.acquire('task', other, 100)).toBe(false)
    await lease.release('task', other)
    expect(await lease.isHeld('task')).toBe(false)
    await expect(lease.acquire('task', winner, 0)).rejects.toThrow()
    const blocking = new SQLite(path)
    try {
      blocking.exec('BEGIN IMMEDIATE')
      native.pragma('busy_timeout = 0')
      await expect(lease.acquire('task', winner, 100)).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
    } finally {
      blocking.exec('ROLLBACK')
      blocking.close()
    }
    native.exec('DROP TABLE scheduled_task_leases')
    await expect(lease.acquire('task', winner, 100)).rejects.toThrow()
  } finally {
    await db.destroy()
    await rm(dir, { recursive: true, force: true })
  }
})
