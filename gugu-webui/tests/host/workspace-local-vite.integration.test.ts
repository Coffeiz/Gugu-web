import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'
import { createPostgresWorkspaceDirectoryOperations } from '../../src/domains/workspaces/persistence/workspace-directories.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '620b9c9d-6955-4502-9ea8-ef337e649781'
const foreignOwnerId = '14892cae-8807-41b7-8df2-5c231de7dad5'
const secret = 'synthetic-workspace-vite-secret'

test('Vite→Node Host→isolated PostgreSQL keeps Local workspace directory CRUD, ownership and disk lifecycle', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated Local workspace integration',
}, async () => {
  const schema = `gugu_workspace_vite_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  const storageRoot = await mkdtemp(join(tmpdir(), 'gugu-workspace-vite-'))
  const app = createApp({
    appName: 'Local workspace Vite integration',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId ? {
          id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
          imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    workspaceDirectories: createPostgresWorkspaceDirectoryOperations(pool, {
      localPath: storageRoot,
      async prepareDirectoryAcl(directoryPath) { await mkdir(directoryPath, { recursive: true }) },
      async terminateActivePty() {},
    }),
  })
  let vite: { listen(): Promise<void>; close(): Promise<void>; httpServer?: { address(): string | { port: number } | null } } | undefined
  const previousProxyTarget = process.env.VITE_API_PROXY_TARGET

  try {
    await pool.query(`
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE workspace_directories (
        id serial PRIMARY KEY, user_id uuid NOT NULL, name varchar(200) NOT NULL,
        directory_name varchar(200) NOT NULL, is_default boolean NOT NULL DEFAULT false,
        is_system boolean NOT NULL DEFAULT false, deleted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX uq_workspace_directory_name
        ON workspace_directories(user_id, directory_name) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX uq_workspace_directory_display_name
        ON workspace_directories(user_id, name) WHERE deleted_at IS NULL;
      CREATE TABLE workspaces (
        id serial PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL, kind text NOT NULL,
        directory_id integer, enabled boolean NOT NULL, is_default boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE files (
        id serial PRIMARY KEY, user_id uuid NOT NULL, workspace_directory_id integer NOT NULL,
        space text NOT NULL, folder_id integer, deleted_at timestamptz, updated_at timestamptz
      );
      CREATE TABLE folders (
        id serial PRIMARY KEY, user_id uuid NOT NULL, workspace_directory_id integer NOT NULL,
        parent_id integer, deleted_at timestamptz, updated_at timestamptz, version integer NOT NULL DEFAULT 1
      );
      CREATE TABLE conversation_sessions (id serial PRIMARY KEY, user_id uuid NOT NULL, workspace_id integer);
      CREATE TABLE scheduled_tasks (id serial PRIMARY KEY, user_id uuid, workspace_id integer, enabled boolean NOT NULL);
      CREATE TABLE terminal_sessions (
        id varchar(80) PRIMARY KEY, owner_id uuid NOT NULL, workspace_id integer,
        status text NOT NULL, closed_at timestamptz, updated_at timestamptz
      );
    `)
    await pool.query('INSERT INTO users(id) VALUES ($1)', [ownerId])
    await pool.query(
      `INSERT INTO workspace_directories(user_id, name, directory_name, is_default, is_system)
       VALUES ($1, '他人目录', 'workspace-foreign', false, false)`, [foreignOwnerId],
    )

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
    const base = `http://127.0.0.1:${address.port}/api/v1/workspace-directories`
    const token = createUserToken(ownerId, 1, secret)
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

    const unauthenticated = await fetch(base)
    assert.equal(unauthenticated.status, 401)

    const createdResponse = await fetch(base, {
      method: 'POST', headers, body: JSON.stringify({ name: '  Local 资料  ' }),
    })
    assert.equal(createdResponse.status, 201)
    const created = await createdResponse.json() as {
      id: number; name: string; directoryName: string; isDefault: boolean; isSystem: boolean
    }
    assert.equal(created.name, 'Local 资料')
    assert.equal(created.isDefault, false)
    assert.equal(created.isSystem, false)
    const directoryPath = join(storageRoot, ownerId, 'workspace', created.directoryName)
    await stat(directoryPath)

    const listedResponse = await fetch(base, { headers })
    assert.equal(listedResponse.status, 200)
    const listed = await listedResponse.json() as Array<{ name: string; isSystem: boolean }>
    assert.deepEqual(listed.map((item) => item.name), ['默认工作区', 'Local 资料'])
    assert.ok(listed.every((item) => item.name !== '他人目录'))

    const renamedResponse = await fetch(`${base}/${created.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ name: 'Local 资料 v2' }),
    })
    assert.equal(renamedResponse.status, 200)
    const renamed = await renamedResponse.json() as { name: string; directoryName: string }
    assert.equal(renamed.name, 'Local 资料 v2')
    assert.equal(renamed.directoryName, created.directoryName)
    await stat(directoryPath)

    const previewResponse = await fetch(`${base}/${created.id}/delete-preview`, { headers })
    assert.equal(previewResponse.status, 200)
    const preview = await previewResponse.json() as { name: string; directory_name: string }
    assert.equal(preview.name, 'Local 资料 v2')
    assert.equal(preview.directory_name, created.directoryName)

    const deletedResponse = await fetch(`${base}/${created.id}`, { method: 'DELETE', headers })
    assert.equal(deletedResponse.status, 200)
    assert.deepEqual(await deletedResponse.json(), { ok: true, workspaceDirectoryId: created.id })
    await assert.rejects(stat(directoryPath), { code: 'ENOENT' })

    const remainingResponse = await fetch(base, { headers })
    const remaining = await remainingResponse.json() as Array<{ name: string }>
    assert.deepEqual(remaining.map((item) => item.name), ['默认工作区'])
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
