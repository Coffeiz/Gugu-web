import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import { tablesSql } from '../../src/data/schema.js'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createKyselySmtpStore, createUserSmtpSettings } from '../../src/preferences/smtp.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
describe.each(['sqlite', 'postgres'] as const)('用户 SMTP 设置 %s', backend => {
  it.skipIf(backend === 'postgres' && !url)('owner 隔离、保留或清除密码、并发与加密失败回滚', async () => {
    const schema = `smtp_${randomUUID().replaceAll('-', '')}`
    const admin = backend === 'postgres' ? new Pool({ connectionString: url }) : undefined
    if (admin) await admin.query(`CREATE SCHEMA "${schema}"`)
    const directory = backend === 'sqlite' ? await mkdtemp(join(tmpdir(), 'gugu-smtp-v13-')) : undefined
    const path = directory ? join(directory, 'core.db') : undefined
    if (path) await initializeSqlite(path)
    const opened = path ? await openSqliteRuntime(path) : undefined
    const db = opened?.runtime.db ?? new Kysely<{}>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, options: `-c search_path=${schema}` }) }) })
    try {
      if (backend === 'postgres') await sql.raw(tablesSql('postgres').userSmtp).execute(db)
      const owner = opened?.ownerId ?? randomUUID(), other = randomUUID()
      if (opened) expect(opened.schemaVersion).toBe('17')
      const stored = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
      const store = createKyselySmtpStore(db, backend, () => '2026-01-01T01:02:03.123Z')
      const app = createUserSmtpSettings(store, password => password ? `cipher:${password}` : '')
      const input = { host: 'smtp.example.test', user: 'x@example.test', password: 'synthetic-secret', use_ssl: true }
      expect(await app.get(owner)).toBeNull()
      expect(await app.put(owner, input)).toEqual({ host: input.host, port: 587, user: input.user, fromAddr: '', useSsl: true, enabled: true, configured: true })
      expect(await app.get(other)).toBeNull()
      expect((await app.put(owner, { ...input, port: ' 465 ', password: null })).port).toBe(465)
      expect((await app.put(owner, { ...input, port: '+465', password: null })).port).toBe(465)
      await expect(app.put(owner, { ...input, port: '\\d' })).rejects.toMatchObject({ code: 'invalid_request' })
      if (backend === 'sqlite') await expect(app.put(other, input)).rejects.toThrow()
      const password = async () => (await sql<{ password: string }>`SELECT password FROM user_smtp_configs WHERE user_id=${stored}`.execute(db)).rows[0]!.password
      expect(await password()).toBe('cipher:synthetic-secret')
      await app.put(owner, { ...input, host: 'new.example.test', password: null })
      expect(await password()).toBe('cipher:synthetic-secret')
      const { password: _ignored, ...withoutPassword } = input
      await Promise.all([app.put(owner, withoutPassword), app.put(owner, { ...withoutPassword, host: 'other.example.test' })])
      expect(await password()).toBe('cipher:synthetic-secret')
      const before = await app.get(owner)
      const failing = createUserSmtpSettings(store, () => { throw new Error('synthetic-secret') })
      await expect(failing.put(owner, { ...input, host: 'must-not-write' })).rejects.toMatchObject({ message: 'SMTP 密码加密失败' })
      expect(await app.get(owner)).toEqual(before)
      await app.put(owner, { ...input, password: '' })
      expect(await password()).toBe('')
      await expect(app.put(owner, { host: '', password: 'synthetic-secret' })).rejects.toMatchObject({ code: 'invalid_request' })
      expect((await sql`SELECT id FROM user_smtp_configs`.execute(db)).rows).toHaveLength(1)
    } finally {
      if (opened) await opened.runtime.close()
      else await db.destroy()
      if (directory) await rm(directory, { recursive: true, force: true })
      if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
    }
  })
})
