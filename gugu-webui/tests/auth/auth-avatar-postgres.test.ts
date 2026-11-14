import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresUserAvatarOperations } from '../../src/domains/auth/persistence/avatar.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('PostgreSQL avatar upload is owner scoped, replaces old local files, and serves only metadata-owned paths', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL avatar integration',
}, async () => {
  const schema = `gugu_auth_avatar_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'gugu-avatar-test-'))
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const ownerId = randomUUID()
  const otherId = randomUUID()

  try {
    await pool.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        username text NOT NULL,
        display_name text,
        email text NOT NULL,
        is_active boolean NOT NULL,
        account_status text,
        security_version integer,
        avatar text,
        created_at timestamptz NOT NULL,
        timezone text,
        email_subscribed boolean
      )
    `)
    await pool.query(`
      CREATE TABLE user_bots (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        platform text NOT NULL,
        enabled boolean NOT NULL
      )
    `)
    await pool.query(`
      INSERT INTO users (id, username, display_name, email, is_active, account_status, security_version, avatar, created_at, timezone, email_subscribed)
      VALUES ($1, 'avatar-user', '头像用户', 'avatar@example.test', TRUE, 'active', 1, NULL, CURRENT_TIMESTAMP, 'Asia/Shanghai', FALSE),
             ($2, 'other-user', '另一用户', 'other@example.test', TRUE, 'active', 1, NULL, CURRENT_TIMESTAMP, NULL, FALSE)
    `, [ownerId, otherId])

    const avatarDirectory = path.join(storageRoot, 'avatars')
    await mkdir(avatarDirectory)
    const oldPath = path.join(avatarDirectory, `${ownerId}.png`)
    await writeFile(oldPath, Buffer.from('old-avatar'))
    await pool.query('UPDATE users SET avatar = $2 WHERE id = $1', [ownerId, `avatars/${ownerId}.png`])
    const operations = createPostgresUserAvatarOperations(pool, storageRoot)

    const uploaded = await operations.upload(ownerId, 'image/webp', Buffer.from('new-avatar'))
    const stored = await pool.query<{ avatar: string }>('SELECT avatar FROM users WHERE id = $1', [ownerId])
    const relative = stored.rows[0]?.avatar
    assert.match(relative ?? '', new RegExp(`^avatars/${ownerId}\\.[0-9a-f]{32}\\.webp$`))
    assert.match(uploaded.avatarUrl ?? '', new RegExp(`^/api/v1/auth/avatar/${ownerId}\\?v=`))
    assert.equal((await readFile(path.join(storageRoot, relative!))).toString(), 'new-avatar')
    assert.equal((await stat(path.join(storageRoot, relative!))).mode & 0o777, 0o600)
    assert.equal(await readFile(oldPath).then(() => true, () => false), false)

    const image = await operations.read(ownerId)
    assert.deepEqual(image, { data: Buffer.from('new-avatar'), mediaType: 'image/webp' })
    assert.equal(await operations.read(otherId), null)
    assert.equal(await operations.read(randomUUID()), null)

    await pool.query('UPDATE users SET avatar = $2 WHERE id = $1', [ownerId, `avatars/${otherId}.png`])
    assert.equal(await operations.read(ownerId), null)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
    await rm(storageRoot, { recursive: true, force: true })
  }
})
