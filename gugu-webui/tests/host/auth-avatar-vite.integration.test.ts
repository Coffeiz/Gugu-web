import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'
import { createPostgresUserAvatarOperations } from '../../src/domains/auth/persistence/avatar.js'
import { createUserRepository } from '../../src/domains/auth/persistence/users.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const secret = 'synthetic-avatar-vite-secret'

test('Vite→Node Host→isolated PostgreSQL uploads an authenticated Local avatar and serves the saved image', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated avatar HTTP integration',
}, async () => {
  const schema = `gugu_avatar_vite_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'gugu-avatar-vite-'))
  const ownerId = randomUUID()
  const foreignId = randomUUID()
  const app = createApp({
    appName: 'Avatar Vite integration',
    isReady: async () => true,
    userAuth: { secret, ...createUserRepository(pool) },
    userAvatar: createPostgresUserAvatarOperations(pool, storageRoot),
  })
  let vite: { listen(): Promise<void>; close(): Promise<void>; httpServer?: { address(): string | { port: number } | null } } | undefined
  const previousProxyTarget = process.env.VITE_API_PROXY_TARGET

  try {
    await pool.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY, username varchar(100) NOT NULL, hashed_password varchar(200) NOT NULL,
        display_name varchar(100), email varchar(300) NOT NULL, is_active boolean NOT NULL,
        account_status varchar(16), security_version integer, avatar varchar(500),
        created_at timestamptz, timezone varchar(64), email_subscribed boolean,
        last_active_at timestamptz
      );
      CREATE TABLE user_bots (
        id serial PRIMARY KEY, user_id uuid NOT NULL, platform varchar(20) NOT NULL, enabled boolean NOT NULL
      );
    `)
    await pool.query(
      `INSERT INTO users
        (id, username, hashed_password, display_name, email, is_active, account_status,
         security_version, avatar, created_at, timezone, email_subscribed)
       VALUES ($1, 'sample', 'not-used', '示例用户', 'sample@example.invalid', TRUE, 'active', 1, $3, CURRENT_TIMESTAMP, NULL, FALSE),
              ($2, 'another', 'not-used', '另一用户', 'another@example.invalid', TRUE, 'active', 1, $4, CURRENT_TIMESTAMP, NULL, FALSE)`,
      [ownerId, foreignId, `avatars/${ownerId}.png`, `avatars/${foreignId}.gif`],
    )
    await pool.query("INSERT INTO user_bots(user_id, platform, enabled) VALUES ($1, 'qq', TRUE), ($2, 'telegram', TRUE)", [ownerId, foreignId])
    const avatarDirectory = path.join(storageRoot, 'avatars')
    await mkdir(avatarDirectory)
    await writeFile(path.join(avatarDirectory, `${ownerId}.png`), Buffer.from('old-owner-avatar'))
    await writeFile(path.join(avatarDirectory, `${foreignId}.gif`), Buffer.from('foreign-avatar'))

    const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
    process.env.VITE_API_PROXY_TARGET = hostAddress
    const frontendRoot = resolve(process.cwd(), '../frontend')
    const requireFrontend = createRequire(resolve(frontendRoot, 'package.json'))
    const viteModule = requireFrontend('vite') as {
      createServer(options: Record<string, unknown>): Promise<{
        listen(): Promise<void>
        close(): Promise<void>
        httpServer?: { address(): string | { port: number } | null }
      }>
    }
    vite = await viteModule.createServer({
      configFile: resolve(frontendRoot, 'vite.config.js'),
      root: frontendRoot,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/api/v1/auth/avatar`
    const ownerToken = createUserToken(ownerId, 1, secret)

    const unauthorizedForm = new FormData()
    unauthorizedForm.append('file', new Blob([Buffer.from('unauthorized')], { type: 'image/png' }), 'avatar.png')
    const unauthorized = await fetch(base, { method: 'POST', body: unauthorizedForm })
    assert.equal(unauthorized.status, 401)

    const form = new FormData()
    form.append('file', new Blob([Buffer.from('new-owner-avatar')], { type: 'image/webp' }), 'clipboard.png')
    const uploaded = await fetch(base, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: form,
    })
    assert.equal(uploaded.status, 200)
    const user = await uploaded.json() as { id: string; avatar_url: string }
    assert.equal(user.id, ownerId)
    assert.match(user.avatar_url, new RegExp(`^/api/v1/auth/avatar/${ownerId}\\?v=`))

    const stored = await pool.query<{ avatar: string }>('SELECT avatar FROM users WHERE id=$1', [ownerId])
    assert.match(stored.rows[0]!.avatar, new RegExp(`^avatars/${ownerId}\\.[0-9a-f]{32}\\.webp$`))
    assert.equal(await readFile(path.join(storageRoot, stored.rows[0]!.avatar), 'utf8'), 'new-owner-avatar')
    await assert.rejects(readFile(path.join(avatarDirectory, `${ownerId}.png`)), { code: 'ENOENT' })
    assert.equal(await readFile(path.join(avatarDirectory, `${foreignId}.gif`), 'utf8'), 'foreign-avatar')

    const read = await fetch(`${base}/${ownerId}`)
    assert.equal(read.status, 200)
    assert.equal(read.headers.get('content-type'), 'image/webp')
    assert.equal(read.headers.get('cache-control'), 'no-cache')
    assert.equal(Buffer.from(await read.arrayBuffer()).toString(), 'new-owner-avatar')

    const unsupportedForm = new FormData()
    unsupportedForm.append('file', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'avatar.svg')
    const unsupported = await fetch(base, {
      method: 'POST', headers: { authorization: `Bearer ${ownerToken}` }, body: unsupportedForm,
    })
    assert.equal(unsupported.status, 400)
    const stillReadable = await fetch(`${base}/${ownerId}`)
    assert.equal(Buffer.from(await stillReadable.arrayBuffer()).toString(), 'new-owner-avatar')
  } finally {
    if (vite) await vite.close()
    await app.close().catch(() => undefined)
    if (previousProxyTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousProxyTarget
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
    await rm(storageRoot, { recursive: true, force: true })
  }
})
