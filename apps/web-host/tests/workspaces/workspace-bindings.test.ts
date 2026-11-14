import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Pool } from 'pg'
import test from 'node:test'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import { CoreError } from '@gugu/core'
import type { UserFromRequest } from '../../src/app.js'
import type { WorkspaceCreateResponse } from '../../src/domains/workspaces/persistence/workspace-create.js'
import { registerWorkspaceRoutes } from '../../src/domains/workspaces/routes/workspaces.js'
import { createPostgresWorkspaceBindingOperations, type WorkspaceBindingOperations } from '../../src/domains/workspaces/persistence/workspace-bindings.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

function workspaceResponse(
  id: number,
  enabled = true,
  kind: WorkspaceCreateResponse['kind'] = 'folder',
): WorkspaceCreateResponse {
  return {
    id,
    name: `Workspace ${id}`,
    kind,
    folderId: null,
    projectId: null,
    directoryId: null,
    enabled,
    isDefault: false,
    boundSessionCount: 1,
  }
}

test('workspace binding routes pass authenticated owner, IDs, and preserve endpoint response shapes', async () => {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  const seen: unknown[] = []
  const userFromRequest = (() => ({
    requestContext: { data: { ownerId } },
  })) as unknown as UserFromRequest
  const operations: WorkspaceBindingOperations = {
    async bind(owner, workspaceId, sessionId) {
      seen.push(['bind', owner, workspaceId, sessionId])
      return workspaceResponse(workspaceId)
    },
    async unbind(owner, sessionId) {
      seen.push(['unbind', owner, sessionId])
    },
    async current(owner, sessionId) {
      seen.push(['current', owner, sessionId])
      return workspaceResponse(7, false)
    },
  }
  registerWorkspaceRoutes(app, userFromRequest, async () => null, operations)
  try {
    const bound = await app.inject({ method: 'POST', url: '/api/v1/workspaces/17/bind/88' })
    const unbound = await app.inject({ method: 'DELETE', url: '/api/v1/workspaces/binding/88' })
    const current = await app.inject({ method: 'GET', url: '/api/v1/workspaces/session/88' })
    const invalidId = await app.inject({ method: 'GET', url: '/api/v1/workspaces/session/not-a-number' })

    assert.equal(bound.statusCode, 200)
    assert.deepEqual(bound.json(), workspaceResponse(17))
    assert.equal(unbound.statusCode, 200)
    assert.deepEqual(unbound.json(), { ok: true, sessionId: 88, workspaceId: null })
    assert.equal(current.statusCode, 200)
    assert.deepEqual(current.json(), { sessionId: 88, workspace: workspaceResponse(7, false) })
    assert.equal(invalidId.statusCode, 422)
    assert.deepEqual(seen, [
      ['bind', ownerId, 17, 88],
      ['unbind', ownerId, 88],
      ['current', ownerId, 88],
    ])
  } finally {
    await app.close()
  }
})

test('workspace binding path IDs preserve FastAPI signed integer parsing and reject malformed values', async () => {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  const seen: unknown[] = []
  const userFromRequest = (() => ({
    requestContext: { data: { ownerId } },
  })) as unknown as UserFromRequest
  const operations: WorkspaceBindingOperations = {
    async bind(owner, workspaceId, sessionId) {
      seen.push([owner, workspaceId, sessionId])
      if (workspaceId <= 0 || sessionId <= 0) throw new CoreError('not_found', '工作区或会话不存在')
      return workspaceResponse(workspaceId)
    },
    async unbind() {},
    async current() { return null },
  }
  registerWorkspaceRoutes(app, userFromRequest, async () => null, operations)
  try {
    const signed = await app.inject({ method: 'POST', url: '/api/v1/workspaces/%2B17/bind/%2B88' })
    const negative = await app.inject({ method: 'POST', url: '/api/v1/workspaces/-17/bind/88' })
    const zero = await app.inject({ method: 'POST', url: '/api/v1/workspaces/0/bind/88' })
    const malformed = await app.inject({ method: 'POST', url: '/api/v1/workspaces/not-an-int/bind/88' })

    assert.equal(signed.statusCode, 200)
    assert.deepEqual(signed.json(), workspaceResponse(17))
    assert.equal(negative.statusCode, 404)
    assert.equal(zero.statusCode, 404)
    assert.equal(malformed.statusCode, 422)
    assert.deepEqual(seen, [
      [ownerId, 17, 88],
      [ownerId, -17, 88],
      [ownerId, 0, 88],
    ])
  } finally {
    await app.close()
  }
})

test('PostgreSQL bind/unbind/current session operations preserve owner and enabled semantics', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_workspace_bind_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  try {
    await pool.query(`
      CREATE TABLE workspaces (
        id integer PRIMARY KEY,
        user_id uuid NOT NULL,
        name varchar(200) NOT NULL,
        kind varchar(20) NOT NULL,
        folder_id integer,
        project_id integer,
        directory_id integer,
        enabled boolean NOT NULL,
        is_default boolean NOT NULL
      )
    `)
    await pool.query(`
      CREATE TABLE conversation_sessions (
        id integer PRIMARY KEY,
        user_id uuid NOT NULL,
        workspace_id integer
      )
    `)
    await pool.query(
      `INSERT INTO workspaces (id, user_id, name, kind, enabled, is_default)
       VALUES (1, $1, 'Active', 'folder', true, false),
              (2, $1, 'Disabled', 'directory', false, false),
              (3, $2, 'Other owner', 'project', true, false)`,
      [ownerId, otherOwnerId],
    )
    await pool.query(
      `INSERT INTO conversation_sessions (id, user_id, workspace_id)
       VALUES (101, $1, NULL), (102, $1, 2), (103, $2, 3), (104, $1, 3)`,
      [ownerId, otherOwnerId],
    )

    const operations = createPostgresWorkspaceBindingOperations(pool)
    const bound = await operations.bind(ownerId, 1, 101)
    const activeWorkspace = { ...workspaceResponse(1), name: 'Active' }
    assert.deepEqual(bound, activeWorkspace)
    const persisted = await pool.query(
      'SELECT workspace_id FROM conversation_sessions WHERE id = 101 AND user_id = $1',
      [ownerId],
    )
    assert.equal(persisted.rows[0]!.workspace_id, 1)
    assert.deepEqual(await operations.current(ownerId, 101), { ...activeWorkspace, boundSessionCount: 0 })

    await assert.rejects(operations.bind(ownerId, 2, 101), { code: 'not_found' })
    await assert.rejects(operations.bind(ownerId, 3, 101), { code: 'not_found' })
    await assert.rejects(operations.bind(ownerId, 1, 103), { code: 'not_found' })
    await assert.rejects(operations.current(ownerId, 103), { code: 'not_found' })
    assert.equal(await operations.current(ownerId, 104), null)
    assert.deepEqual(await operations.current(ownerId, 102), {
      ...workspaceResponse(2, false, 'directory'), name: 'Disabled',
      boundSessionCount: 0,
    }, 'current session returns its owned disabled workspace as Python get_workspace does')

    await operations.unbind(ownerId, 101)
    assert.equal(await operations.current(ownerId, 101), null)
    await assert.rejects(operations.unbind(ownerId, 103), { code: 'not_found' })

  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
