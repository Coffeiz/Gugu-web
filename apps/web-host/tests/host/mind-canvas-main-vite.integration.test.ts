import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'
import { after, test } from 'node:test'
import { createUserToken } from '../../src/domains/auth/auth.js'
import { startServer } from '../../src/main.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '00000000-0000-4000-8000-000000000073'
const otherOwnerId = '00000000-0000-4000-8000-000000000074'
const secret = 'synthetic-mind-main-vite-secret'

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose())
  })
  return address.port
}

test('Vite→生产 main.ts→Node Host→隔离 PostgreSQL 可增删改画布条目', {
  skip: !databaseUrl && '需要显式提供 GUGU_WEBUI_TEST_DATABASE_URL 运行隔离 PostgreSQL HTTP 集成',
}, async () => {
  const schema = `gugu_mind_main_http_${randomUUID().replaceAll('-', '')}`
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const scopedUrl = new URL(databaseUrl!)
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: scopedUrl.toString(), max: 3 })
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'gugu-mind-main-vite-'))
  const storageRoot = join(temporaryRoot, 'storage')
  const overridePath = join(temporaryRoot, 'config.override.json')
  const viteServers: Array<{ listen(): Promise<void>; close(): Promise<void>; httpServer?: { address(): string | { port: number } | null } }> = []
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  let previousProxyTarget: string | undefined

  try {
    await writeFile(overridePath, '{}\n', 'utf8')
    await pool.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY, username text NOT NULL, display_name text, email text NOT NULL,
        is_active boolean NOT NULL, account_status text, security_version integer,
        avatar text, created_at timestamptz, timezone text, email_subscribed boolean,
        is_developer boolean NOT NULL DEFAULT FALSE, last_active_at timestamptz,
        storage_limit_bytes bigint, hashed_password text
      );
      CREATE TABLE user_bots (
        id serial PRIMARY KEY, user_id uuid NOT NULL, platform text NOT NULL, enabled boolean NOT NULL
      );
      CREATE TABLE mind_maps (
        id bigserial PRIMARY KEY, user_id uuid NOT NULL, title varchar(300) NOT NULL,
        project_id integer, data_json text NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE mind_nodes (
        id bigserial PRIMARY KEY, user_id uuid NOT NULL, kind varchar(20) NOT NULL, title varchar(300),
        content_md text NOT NULL, content_plain text NOT NULL, color varchar(300), ref_type varchar(20),
        ref_id integer, ref_snapshot jsonb, origin varchar(10) NOT NULL, indexed_at timestamptz,
        indexed_hash varchar(64), version integer NOT NULL, captured_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz,
        UNIQUE (user_id, ref_type, ref_id)
      );
      CREATE TABLE projects (
        id serial PRIMARY KEY, user_id uuid NOT NULL, name varchar(300) NOT NULL, color varchar(300),
        contact_name varchar(200), status varchar(30) NOT NULL, start_date varchar(10), deadline varchar(10),
        done_at timestamptz, current_stage text, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deleted_at timestamptz
      );
      CREATE TABLE files (
        id serial PRIMARY KEY, user_id uuid NOT NULL, display_name varchar(300) NOT NULL,
        ext varchar(50) NOT NULL, space varchar(32) NOT NULL DEFAULT 'mind', size bigint NOT NULL DEFAULT 0,
        folder_id bigint, workspace_directory_id bigint, project_id integer,
        search_romaji text, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at timestamptz
      );
      CREATE TABLE folders (
        id bigserial PRIMARY KEY, user_id uuid NOT NULL, name varchar(300) NOT NULL,
        project_id integer, workspace_directory_id bigint, parent_id bigint,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        search_romaji text, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deleted_at timestamptz
      );
      CREATE TABLE calendar_events (
        id serial PRIMARY KEY, user_id uuid NOT NULL, title varchar(300) NOT NULL, date varchar(10) NOT NULL,
        time varchar(5), end_time varchar(5), description text, contact_name text,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at timestamptz
      );
      CREATE TABLE user_skills (
        id bigserial PRIMARY KEY, owner_id uuid NOT NULL, skill_id varchar(16) NOT NULL, name varchar(120) NOT NULL,
        description_short text, description_long text, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE user_mcp_servers (
        id uuid PRIMARY KEY, user_id uuid, scope varchar(16) NOT NULL, name varchar(64) NOT NULL,
        transport varchar(16) NOT NULL, enabled boolean NOT NULL DEFAULT TRUE,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE scheduled_tasks (
        id bigserial PRIMARY KEY, user_id uuid, name varchar(100) NOT NULL, cron varchar(60) NOT NULL,
        enabled boolean NOT NULL DEFAULT TRUE, end_at timestamptz, schedule_kind varchar(16) NOT NULL DEFAULT 'cron',
        interval_minutes integer, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE conversation_sessions (
        id bigserial PRIMARY KEY, user_id uuid NOT NULL, title varchar(300) NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE conversation_messages (
        id bigserial PRIMARY KEY, session_id bigint NOT NULL, role varchar(20) NOT NULL,
        content text NOT NULL DEFAULT '', content_json jsonb, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE mind_canvas_items (
        id bigserial PRIMARY KEY, user_id uuid NOT NULL, canvas_id bigint NOT NULL, node_id bigint NOT NULL,
        x double precision NOT NULL, y double precision NOT NULL, w double precision, h double precision,
        z integer NOT NULL, collapsed boolean NOT NULL, data_json text NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz,
        UNIQUE (canvas_id, node_id)
      );
      CREATE TABLE mind_relations (
      id bigserial PRIMARY KEY, user_id uuid NOT NULL, canvas_id bigint,
        src_node_id bigint NOT NULL, dst_node_id bigint NOT NULL, rel_type varchar(32) NOT NULL,
        edge_key varchar(32) NOT NULL DEFAULT '', note text,
        origin varchar(16) NOT NULL, status varchar(16) NOT NULL,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz,
        UNIQUE (user_id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key)
      );
      CREATE TABLE undo_operations (
        id varchar(80) PRIMARY KEY, user_id uuid NOT NULL, undo_context_id varchar(128) NOT NULL,
        group_id varchar(80) NOT NULL, resource varchar(32) NOT NULL, action varchar(32) NOT NULL,
        target_refs json NOT NULL, before_state json NOT NULL, after_state json NOT NULL,
        base_versions json NOT NULL, artifact_refs json NOT NULL, actor_type varchar(32) NOT NULL,
        status varchar(24) NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
        undone_at timestamptz, failure_code varchar(80)
      );
    `)
    const now = new Date()
    await pool.query(
      `INSERT INTO users (
         id, username, display_name, email, is_active, account_status, security_version,
         created_at, timezone, email_subscribed
       ) VALUES ($1, 'sample-user', '示例用户', 'sample@example.invalid', TRUE, 'active', 1, $2, 'UTC', FALSE)`,
      [ownerId, now],
    )
    await pool.query(
      `INSERT INTO users (
         id, username, display_name, email, is_active, account_status, security_version,
         created_at, timezone, email_subscribed
       ) VALUES ($1, 'other-sample-user', '另一位示例用户', 'other@example.invalid', TRUE, 'active', 1, $2, 'UTC', FALSE)`,
      [otherOwnerId, now],
    )
    const projectResult = await pool.query<{ id: number | string }>(
      `INSERT INTO projects (user_id, name, color, contact_name, status, start_date, deadline, done_at)
       VALUES ($1, '引用快照项目', 'linear-gradient(135deg,#7b7fb2,#c4afc8)', '小北', 'active',
               '2026-11-01', '2026-12-01', NULL) RETURNING id`,
      [ownerId],
    )
    const projectId = Number(projectResult.rows[0]?.id)
    const fileResult = await pool.query<{ id: number | string }>(
      `INSERT INTO files (user_id, display_name, ext, deleted_at) VALUES ($1, '引用文件', 'md', NULL) RETURNING id`,
      [ownerId],
    )
    const fileId = Number(fileResult.rows[0]?.id)
    const eventResult = await pool.query<{ id: number | string }>(
      `INSERT INTO calendar_events (user_id, title, date, time, end_time, deleted_at)
       VALUES ($1, '引用活动', '2026-11-14', '09:30', '10:15', NULL) RETURNING id`,
      [ownerId],
    )
    const eventId = Number(eventResult.rows[0]?.id)
    const conversation = await pool.query<{ id: number | string }>(
      'INSERT INTO conversation_sessions (user_id, title) VALUES ($1, $2) RETURNING id',
      [ownerId, '引用消息会话'],
    )
    const conversationId = Number(conversation.rows[0]?.id)
    const message = await pool.query<{ id: number | string }>(
      `INSERT INTO conversation_messages (session_id, role, content, content_json)
       VALUES ($1, 'assistant', '消息包含定位短语', NULL) RETURNING id`,
      [conversationId],
    )
    const messageId = Number(message.rows[0]?.id)
    await pool.query(
      `INSERT INTO projects (user_id, name, status, contact_name) VALUES ($1, '外部搜索隔离词', 'active', 'moon_小北')`,
      [otherOwnerId],
    )
    const insertedNode = await pool.query<{ id: number | string }>(
      `INSERT INTO mind_nodes (
         user_id, kind, title, content_md, content_plain, color, ref_type, ref_id, ref_snapshot,
         origin, indexed_at, indexed_hash, version, captured_at, created_at, updated_at, deleted_at
       ) VALUES ($1, 'note', '生产组合根记录', '保留在记录流', '保留在记录流', NULL,
         NULL, NULL, NULL, 'web', NULL, NULL, 1, $2, $2, $2, NULL) RETURNING id`,
      [ownerId, now],
    )
    const nodeId = Number(insertedNode.rows[0]?.id)
    assert.ok(nodeId > 0)
    const insertedTarget = await pool.query<{ id: number | string }>(
      `INSERT INTO mind_nodes (
         user_id, kind, title, content_md, content_plain, color, ref_type, ref_id, ref_snapshot,
         origin, indexed_at, indexed_hash, version, captured_at, created_at, updated_at, deleted_at
       ) VALUES ($1, 'note', '关系目标记录', '目标正文', '目标正文', NULL,
         NULL, NULL, NULL, 'web', NULL, NULL, 1, $2, $2, $2, NULL) RETURNING id`,
      [ownerId, now],
    )
    const targetNodeId = Number(insertedTarget.rows[0]?.id)
    assert.ok(targetNodeId > 0)

    const port = await freePort()
    host = await startServer({
      GUGU_WEBUI_DATABASE_URL: scopedUrl.toString(),
      GUGU_WEBUI_SECRET_KEY: secret,
      GUGU_CONFIG_OVERRIDE_FILE: overridePath,
      GUGU_WEBUI_HOST: '127.0.0.1',
      GUGU_WEBUI_PORT: String(port),
      GUGU_WEBUI_REDIS_URL: '',
      STORAGE__LOCAL_PATH: storageRoot,
    })

    previousProxyTarget = process.env.VITE_API_PROXY_TARGET
    process.env.VITE_API_PROXY_TARGET = `http://127.0.0.1:${port}`
    const frontendRoot = resolve(process.cwd(), '../web')
    const requireFrontend = createRequire(resolve(frontendRoot, 'package.json'))
    const viteModule = requireFrontend('vite') as {
      createServer(options: Record<string, unknown>): Promise<{
        listen(): Promise<void>
        close(): Promise<void>
        httpServer?: { address(): string | { port: number } | null }
      }>
    }
    const vite = await viteModule.createServer({
      configFile: resolve(frontendRoot, 'vite.config.js'),
      root: frontendRoot,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    })
    viteServers.push(vite)
    await vite.listen()
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/api/v1/mind/canvases`
    const headers = {
      authorization: `Bearer ${createUserToken(ownerId, 1, secret)}`,
      'content-type': 'application/json',
      'x-undo-context-id': 'main-mind-tab',
    }
    const mindBase = `http://127.0.0.1:${address.port}/api/v1/mind`

    const unauthenticated = await fetch(base)
    assert.equal(unauthenticated.status, 401)
    const undoBase = `http://127.0.0.1:${address.port}/api/v1/undo`
    assert.equal((await fetch(`${undoBase}/preview?context_id=main-undo-tab`)).status, 401)
    const undoHeaders = { ...headers, 'x-undo-context-id': 'main-undo-tab' }
    const createdNoteResponse = await fetch(`${mindBase}/notes`, {
      method: 'POST', headers: undoHeaders, body: JSON.stringify({ content_md: '撤销回归正文' }),
    })
    assert.equal(createdNoteResponse.status, 201)
    const createdNote = await createdNoteResponse.json() as { id: number }
    const preview = await fetch(`${undoBase}/preview?context_id=main-undo-tab`, { headers: undoHeaders })
    assert.equal(preview.status, 200)
    const operationId = (await preview.json() as { undo: { operation_id: string } }).undo.operation_id
    const requestBody = JSON.stringify({ operation_id: operationId, context_id: 'main-undo-tab' })
    const foreignUndo = await fetch(undoBase, { method: 'POST', headers: {
      ...undoHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}`,
    }, body: requestBody })
    assert.equal(foreignUndo.status, 404)
    const undone = await fetch(undoBase, { method: 'POST', headers: undoHeaders, body: requestBody })
    assert.equal(undone.status, 200)
    assert.deepEqual((await undone.json() as { events: Array<{ resource: string; operation: string }> }).events.map(({ resource, operation }) => ({ resource, operation })), [{ resource: 'mind', operation: 'delete' }])
    assert.equal((await fetch(`${mindBase}/notes/${createdNote.id}`, { headers: undoHeaders })).status, 404)
    const redone = await fetch(`${undoBase}/redo`, { method: 'POST', headers: undoHeaders, body: requestBody })
    assert.equal(redone.status, 200)
    assert.deepEqual((await redone.json() as { events: Array<{ resource: string; operation: string }> }).events.map(({ resource, operation }) => ({ resource, operation })), [{ resource: 'mind', operation: 'create' }])
    const restored = await fetch(`${mindBase}/notes/${createdNote.id}`, { headers: undoHeaders })
    assert.equal(restored.status, 200)
    assert.equal((await restored.json() as { version: number }).version, 3)
    const noteUrl = `${mindBase}/notes/${createdNote.id}`
    const foreignHeaders = { ...undoHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
    assert.equal((await fetch(noteUrl, { headers: foreignHeaders })).status, 404)
    assert.equal((await fetch(noteUrl, { method: 'PATCH', headers: foreignHeaders, body: JSON.stringify({ version: 3, title: '越权' }) })).status, 404)
    assert.equal((await fetch(noteUrl, { method: 'DELETE', headers: foreignHeaders })).status, 404)
    assert.equal((await fetch(noteUrl, { method: 'PATCH', headers: undoHeaders, body: JSON.stringify({ version: 1, title: '旧版本' }) })).status, 409)
    const updatedNote = await fetch(noteUrl, { method: 'PATCH', headers: undoHeaders, body: JSON.stringify({ version: 3, title: '更新后的标题' }) })
    assert.equal(updatedNote.status, 200)
    assert.equal((await updatedNote.json() as { title: string }).title, '更新后的标题')
    async function latestUndoBody(): Promise<string> {
      const result = await fetch(`${undoBase}/preview?context_id=main-undo-tab`, { headers: undoHeaders })
      assert.equal(result.status, 200)
      const id = (await result.json() as { undo: { operation_id: string } }).undo.operation_id
      return JSON.stringify({ operation_id: id, context_id: 'main-undo-tab' })
    }
    const updateUndoBody = await latestUndoBody()
    assert.equal((await fetch(undoBase, { method: 'POST', headers: undoHeaders, body: updateUndoBody })).status, 200)
    assert.equal((await (await fetch(noteUrl, { headers: undoHeaders })).json() as { title: string | null }).title, null)
    assert.equal((await fetch(`${undoBase}/redo`, { method: 'POST', headers: undoHeaders, body: updateUndoBody })).status, 200)
    assert.equal((await (await fetch(noteUrl, { headers: undoHeaders })).json() as { title: string }).title, '更新后的标题')
    assert.equal((await fetch(noteUrl, { method: 'DELETE', headers: undoHeaders })).status, 204)
    assert.equal((await fetch(noteUrl, { headers: undoHeaders })).status, 404)
    const deleteUndoBody = await latestUndoBody()
    assert.equal((await fetch(undoBase, { method: 'POST', headers: undoHeaders, body: deleteUndoBody })).status, 200)
    assert.equal((await (await fetch(noteUrl, { headers: undoHeaders })).json() as { title: string }).title, '更新后的标题')
    assert.equal((await fetch(`${undoBase}/redo`, { method: 'POST', headers: undoHeaders, body: deleteUndoBody })).status, 200)
    assert.equal((await fetch(noteUrl, { headers: undoHeaders })).status, 404)
    const recentSuggestionsResponse = await fetch(`${mindBase}/ref-suggest?limit=6`, { headers })
    assert.equal(recentSuggestionsResponse.status, 200)
    const recentSuggestions = await recentSuggestionsResponse.json() as Array<{ type: string; id: number | string; label: string; subtitle?: string }>
    assert.deepEqual(recentSuggestions.slice(0, 3), [
      { type: 'project', id: projectId, label: '引用快照项目', subtitle: '小北' },
      { type: 'file', id: fileId, label: '引用文件.md', subtitle: 'mind' },
      { type: 'event', id: eventId, label: '引用活动', subtitle: '2026-11-14' },
    ])
    const projectSuggestionsResponse = await fetch(`${mindBase}/ref-suggest?q=${encodeURIComponent('引用快照项目')}`, { headers })
    assert.equal(projectSuggestionsResponse.status, 200)
    const projectSuggestions = await projectSuggestionsResponse.json() as Array<{ type: string; id: number; label: string }>
    assert.ok(projectSuggestions.some((item) => item.type === 'project' && item.id === projectId && item.label === '引用快照项目'))
    const messageSuggestionsResponse = await fetch(`${mindBase}/ref-suggest?q=${encodeURIComponent('定位短语')}`, { headers })
    assert.equal(messageSuggestionsResponse.status, 200)
    assert.deepEqual(await messageSuggestionsResponse.json(), [
      { type: 'conversation', id: messageId, label: '消息包含定位短语', subtitle: '引用消息会话' },
    ])
    const foreignSuggestionsResponse = await fetch(`${mindBase}/ref-suggest?q=${encodeURIComponent('外部搜索隔离词')}`, { headers })
    assert.deepEqual(await foreignSuggestionsResponse.json(), [])
    const canvasHeaders = { ...headers, 'x-undo-context-id': 'main-canvas-create-tab' }
    const foreignCanvasHeaders = { ...canvasHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
    const foreignProjectCreate = await fetch(base, { method: 'POST', headers: foreignCanvasHeaders, body: JSON.stringify({ projectId, title: '越权画布' }) })
    assert.equal(foreignProjectCreate.status, 404)
    const canvasCreate = await fetch(base, { method: 'POST', headers: canvasHeaders, body: JSON.stringify({ projectId, title: '  项目画布  ' }) })
    assert.equal(canvasCreate.status, 201)
    const createdProjectCanvas = await canvasCreate.json() as { id: number; title: string; projectId: number; data: object }
    assert.equal(createdProjectCanvas.title, '项目画布')
    assert.equal(createdProjectCanvas.projectId, projectId)
    assert.deepEqual(createdProjectCanvas.data, {})
    async function listedCanvas(headersToUse: typeof canvasHeaders) {
      const response = await fetch(base, { headers: headersToUse })
      assert.equal(response.status, 200)
      return (await response.json() as Array<{ id: number }>).some(item => item.id === createdProjectCanvas.id)
    }
    assert.equal(await listedCanvas(canvasHeaders), true)
    assert.equal(await listedCanvas(foreignCanvasHeaders), false)
    const canvasPreview = await fetch(`${undoBase}/preview?context_id=main-canvas-create-tab`, { headers: canvasHeaders })
    assert.equal(canvasPreview.status, 200)
    const canvasOperationId = (await canvasPreview.json() as { undo: { operation_id: string } }).undo.operation_id
    const canvasUndoBody = JSON.stringify({ operation_id: canvasOperationId, context_id: 'main-canvas-create-tab' })
    assert.equal((await fetch(undoBase, { method: 'POST', headers: foreignCanvasHeaders, body: canvasUndoBody })).status, 404)
    assert.equal((await fetch(undoBase, { method: 'POST', headers: canvasHeaders, body: canvasUndoBody })).status, 200)
    assert.equal(await listedCanvas(canvasHeaders), false)
    assert.equal((await fetch(`${undoBase}/redo`, { method: 'POST', headers: canvasHeaders, body: canvasUndoBody })).status, 200)
    assert.equal(await listedCanvas(canvasHeaders), true)
    const updateCanvasHeaders = { ...headers, 'x-undo-context-id': 'main-canvas-update-tab' }
    const foreignUpdateHeaders = { ...updateCanvasHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
    const canvasUrl = `${base}/${createdProjectCanvas.id}`
    assert.equal((await fetch(canvasUrl, { method: 'PATCH', headers: foreignUpdateHeaders, body: JSON.stringify({ title: '越权修改' }) })).status, 404)
    const canvasUpdate = await fetch(canvasUrl, { method: 'PATCH', headers: updateCanvasHeaders, body: JSON.stringify({ title: '更新画布', data: { zoom: 1.5 } }) })
    assert.equal(canvasUpdate.status, 200)
    const updatedCanvas = await canvasUpdate.json() as { title: string; data: object }
    assert.equal(updatedCanvas.title, '更新画布')
    assert.deepEqual(updatedCanvas.data, { zoom: 1.5 })
    const updatePreview = await fetch(`${undoBase}/preview?context_id=main-canvas-update-tab`, { headers: updateCanvasHeaders })
    assert.equal(updatePreview.status, 200)
    const updateOperation = (await updatePreview.json() as { undo: { operation_id: string } }).undo.operation_id
    const updateBody = JSON.stringify({ operation_id: updateOperation, context_id: 'main-canvas-update-tab' })
    assert.equal((await fetch(undoBase, { method: 'POST', headers: foreignUpdateHeaders, body: updateBody })).status, 404)
    async function readUpdatedCanvas() {
      const response = await fetch(base, { headers: updateCanvasHeaders })
      assert.equal(response.status, 200)
      const rows = await response.json() as Array<{ id: number; title: string; data: object }>
      const row = rows.find(item => item.id === createdProjectCanvas.id)
      assert.ok(row)
      return row
    }
    assert.equal((await fetch(undoBase, { method: 'POST', headers: updateCanvasHeaders, body: updateBody })).status, 200)
    const updateUndone = await readUpdatedCanvas()
    assert.equal(updateUndone.title, '项目画布')
    assert.deepEqual(updateUndone.data, {})
    assert.equal((await fetch(`${undoBase}/redo`, { method: 'POST', headers: updateCanvasHeaders, body: updateBody })).status, 200)
    const updateRedone = await readUpdatedCanvas()
    assert.equal(updateRedone.title, '更新画布')
    assert.deepEqual(updateRedone.data, { zoom: 1.5 })
    const createdCanvasResponse = await fetch(base, {
      method: 'POST', headers, body: JSON.stringify({ title: '生产组合根画布' }),
    })
    assert.equal(createdCanvasResponse.status, 201)
    const canvas = await createdCanvasResponse.json() as { id: number }

    const projectRefResponse = await fetch(`${mindBase}/nodes/ref`, {
      method: 'POST', headers, body: JSON.stringify({ refType: 'project', refId: projectId }),
    })
    assert.equal(projectRefResponse.status, 201)
    const projectRef = await projectRefResponse.json() as {
      id: number; kind: string; title: string; color: string; refType: string; refId: number;
      refSnapshot: Record<string, unknown>;
    }
    assert.deepEqual({
      kind: projectRef.kind, title: projectRef.title, color: projectRef.color,
      refType: projectRef.refType, refId: projectRef.refId, refSnapshot: projectRef.refSnapshot,
    }, {
      kind: 'ref', title: '引用快照项目', color: 'linear-gradient(135deg,#7b7fb2,#c4afc8)',
      refType: 'project', refId: projectId,
      refSnapshot: { client: '小北', status: 'active', startDate: '2026-11-01', deadline: '2026-12-01', doneAt: null },
    })
    const duplicateProjectRef = await fetch(`${mindBase}/nodes/ref`, {
      method: 'POST', headers, body: JSON.stringify({ ref_type: 'project', ref_id: projectId }),
    })
    assert.equal(duplicateProjectRef.status, 201)
    assert.equal((await duplicateProjectRef.json() as { id: number }).id, projectRef.id)
    const projectRefUndoCount = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM undo_operations
       WHERE user_id=$1 AND undo_context_id='main-mind-tab'
         AND target_refs::jsonb @> $2::jsonb`,
      [ownerId, JSON.stringify([{ kind: 'ref_node', id: projectRef.id }])],
    )
    assert.equal(projectRefUndoCount.rows[0]?.count, 1)

    const fileRefResponse = await fetch(`${mindBase}/nodes/ref`, {
      method: 'POST', headers, body: JSON.stringify({ refType: 'file', refId: fileId }),
    })
    assert.equal(fileRefResponse.status, 201)
    const fileRef = await fileRefResponse.json() as { refSnapshot: Record<string, unknown> }
    assert.deepEqual(fileRef.refSnapshot, { ext: 'md' })
    const eventRefResponse = await fetch(`${mindBase}/nodes/ref`, {
      method: 'POST', headers, body: JSON.stringify({ refType: 'event', refId: eventId }),
    })
    assert.equal(eventRefResponse.status, 201)
    const eventRef = await eventRefResponse.json() as { id: number; refSnapshot: Record<string, unknown> }
    assert.deepEqual(eventRef.refSnapshot, { date: '2026-11-14', time: '09:30', endTime: '10:15' })

    const referenceHeaders = { ...headers, 'x-undo-context-id': 'reference-concurrency-tab' }
    const foreignReferenceHeaders = { ...referenceHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
    for (const [type, id] of [['project', projectId], ['file', fileId], ['event', eventId]] as const) {
      assert.equal((await fetch(`${mindBase}/nodes/ref`, { method: 'POST', headers: foreignReferenceHeaders, body: JSON.stringify({ refType: type, refId: id }) })).status, 404)
    }
    const softProject = await pool.query<{ id: number }>("INSERT INTO projects (user_id,name,status,deleted_at) VALUES ($1,'已删项目','active',CURRENT_TIMESTAMP) RETURNING id", [ownerId])
    const softEvent = await pool.query<{ id: number }>("INSERT INTO calendar_events (user_id,title,date,deleted_at) VALUES ($1,'已删活动','2026-11-14',CURRENT_TIMESTAMP) RETURNING id", [ownerId])
    const softFile = await pool.query<{ id: number }>("INSERT INTO files (user_id,display_name,ext,deleted_at) VALUES ($1,'已删文件','txt',CURRENT_TIMESTAMP) RETURNING id", [ownerId])
    assert.equal((await fetch(`${mindBase}/nodes/ref`, { method: 'POST', headers: referenceHeaders, body: JSON.stringify({ refType: 'project', refId: softProject.rows[0]!.id }) })).status, 201)
    assert.equal((await fetch(`${mindBase}/nodes/ref`, { method: 'POST', headers: referenceHeaders, body: JSON.stringify({ refType: 'event', refId: softEvent.rows[0]!.id }) })).status, 201)
    assert.equal((await fetch(`${mindBase}/nodes/ref`, { method: 'POST', headers: referenceHeaders, body: JSON.stringify({ refType: 'file', refId: softFile.rows[0]!.id }) })).status, 404)
    const concurrentFile = await pool.query<{ id: number }>("INSERT INTO files (user_id,display_name,ext) VALUES ($1,'并发文件','txt') RETURNING id", [ownerId])
    const concurrentHeaders = { ...headers, 'x-undo-context-id': 'reference-concurrent-file-tab' }
    const createConcurrentRef = () => fetch(`${mindBase}/nodes/ref`, { method: 'POST', headers: concurrentHeaders, body: JSON.stringify({ refType: 'file', refId: concurrentFile.rows[0]!.id }) })
    const concurrentResponses = await Promise.all([createConcurrentRef(), createConcurrentRef(), createConcurrentRef()])
    assert.deepEqual(concurrentResponses.map(row => row.status), [201, 201, 201])
    const concurrentRefs = await Promise.all(concurrentResponses.map(row => row.json() as Promise<{ id: number; refSnapshot: object }>))
    assert.equal(new Set(concurrentRefs.map(row => row.id)).size, 1)
    assert.deepEqual(concurrentRefs[0]!.refSnapshot, { ext: 'txt' })
    const concurrentRefId = concurrentRefs[0]!.id
    assert.equal((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM undo_operations WHERE user_id=$1 AND undo_context_id='reference-concurrent-file-tab'", [ownerId])).rows[0]?.count, 1)
    const refPreview = await fetch(`${undoBase}/preview?context_id=reference-concurrent-file-tab`, { headers: concurrentHeaders })
    assert.equal(refPreview.status, 200)
    const refOperation = (await refPreview.json() as { undo: { operation_id: string } }).undo.operation_id
    const refBody = JSON.stringify({ operation_id: refOperation, context_id: 'reference-concurrent-file-tab' })
    assert.equal((await fetch(undoBase, { method: 'POST', headers: foreignReferenceHeaders, body: refBody })).status, 404)
    assert.equal((await fetch(undoBase, { method: 'POST', headers: concurrentHeaders, body: refBody })).status, 200)
    assert.ok((await pool.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM mind_nodes WHERE id=$1 AND user_id=$2', [concurrentRefId, ownerId])).rows[0]?.deleted_at)
    assert.equal((await fetch(`${undoBase}/redo`, { method: 'POST', headers: concurrentHeaders, body: refBody })).status, 200)
    assert.equal((await pool.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM mind_nodes WHERE id=$1 AND user_id=$2', [concurrentRefId, ownerId])).rows[0]?.deleted_at, null)
    const eventItemHeaders = { ...headers, 'x-undo-context-id': 'event-item-add-tab' }
    const foreignEventItemHeaders = { ...eventItemHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
    const eventItemUrl = `${base}/${createdProjectCanvas.id}/items`
    assert.equal((await fetch(eventItemUrl, { method: 'POST', headers: foreignEventItemHeaders, body: JSON.stringify({ nodeId: eventRef.id }) })).status, 404)
    const eventItemResponse = await fetch(eventItemUrl, { method: 'POST', headers: eventItemHeaders, body: JSON.stringify({ nodeId: eventRef.id, x: 10, y: 20 }) })
    assert.equal(eventItemResponse.status, 201)
    const eventItem = await eventItemResponse.json() as { id: number; x: number; refData: object; node: { id: number } }
    assert.equal(eventItem.node.id, eventRef.id)
    assert.deepEqual(eventItem.refData, { date: '2026-11-14', time: '09:30', endTime: '10:15', description: null })
    const eventItemsRead = await fetch(eventItemUrl, { headers })
    assert.equal(eventItemsRead.status, 200)
    assert.deepEqual((await eventItemsRead.json() as Array<{ refData: object }>)[0]?.refData, eventItem.refData)
    assert.equal((await fetch(eventItemUrl, { headers: foreignEventItemHeaders })).status, 404)
    const projectCanvasList = await fetch(`${base}?project_id=${projectId}`, { headers })
    assert.ok((await projectCanvasList.json() as Array<{ id: number }>).some(row => row.id === createdProjectCanvas.id))

    const duplicateItemResponse = await fetch(eventItemUrl, { method: 'POST', headers: eventItemHeaders, body: JSON.stringify({ nodeId: eventRef.id, x: 99 }) })
    assert.equal(duplicateItemResponse.status, 201)
    const duplicateEventItem = await duplicateItemResponse.json() as { id: number; x: number }
    assert.equal(duplicateEventItem.id, eventItem.id)
    assert.equal(duplicateEventItem.x, 10)
    const eventItemUndoCount = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM undo_operations WHERE user_id=$1 AND undo_context_id='event-item-add-tab'", [ownerId])
    assert.equal(eventItemUndoCount.rows[0]?.count, 1)
    const eventItemPreview = await fetch(`${undoBase}/preview?context_id=event-item-add-tab`, { headers: eventItemHeaders })
    assert.equal(eventItemPreview.status, 200)
    const eventItemOperation = (await eventItemPreview.json() as { undo: { operation_id: string } }).undo.operation_id
    const eventItemUndoBody = JSON.stringify({ operation_id: eventItemOperation, context_id: 'event-item-add-tab' })
    assert.equal((await fetch(undoBase, { method: 'POST', headers: foreignEventItemHeaders, body: eventItemUndoBody })).status, 404)
    assert.equal((await fetch(undoBase, { method: 'POST', headers: eventItemHeaders, body: eventItemUndoBody })).status, 200)
    assert.deepEqual(await (await fetch(eventItemUrl, { headers })).json(), [])
    assert.equal((await fetch(`${undoBase}/redo`, { method: 'POST', headers: eventItemHeaders, body: eventItemUndoBody })).status, 200)
    assert.equal((await (await fetch(eventItemUrl, { headers })).json() as Array<{ id: number }>)[0]?.id, eventItem.id)
    assert.equal((await fetch(`${eventItemUrl}/${eventItem.id}`, { method: 'DELETE', headers })).status, 204)
    const restoredEventItemResponse = await fetch(eventItemUrl, { method: 'POST', headers: eventItemHeaders, body: JSON.stringify({ nodeId: eventRef.id, x: 42 }) })
    assert.equal(restoredEventItemResponse.status, 201)
    const restoredEventItem = await restoredEventItemResponse.json() as { id: number; x: number; refData: object }
    assert.equal(restoredEventItem.id, eventItem.id)
    assert.equal(restoredEventItem.x, 42)
    assert.deepEqual(restoredEventItem.refData, eventItem.refData)
    const foreignProjectRef = await fetch(`${mindBase}/nodes/ref`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ refType: 'project', refId: projectId }),
    })
    assert.equal(foreignProjectRef.status, 404)

    const addedResponse = await fetch(`${base}/${canvas.id}/items`, {
      method: 'POST', headers, body: JSON.stringify({ nodeId, x: 10, y: 20, z: 0 }),
    })
    assert.equal(addedResponse.status, 201)
    const item = await addedResponse.json() as { id: number; nodeId: number }
    assert.equal(item.nodeId, nodeId)

    const targetItemResponse = await fetch(`${base}/${canvas.id}/items`, {
      method: 'POST', headers, body: JSON.stringify({ nodeId: targetNodeId, x: 70, y: 80, z: 1000 }),
    })
    assert.equal(targetItemResponse.status, 201)
    const targetItem = await targetItemResponse.json() as { id: number }

    const missingCanvasRelation = await fetch(`${mindBase}/relations`, { method: 'POST', headers, body: JSON.stringify({ srcNodeId: nodeId, dstNodeId: targetNodeId }) })
    assert.equal(missingCanvasRelation.status, 422)
    const nullCanvasRelation = await fetch(`${mindBase}/relations`, { method: 'POST', headers, body: JSON.stringify({ canvasId: null, srcNodeId: nodeId, dstNodeId: targetNodeId }) })
    assert.equal(nullCanvasRelation.status, 422)
    const relationCreateHeaders = { ...headers, 'x-undo-context-id': 'canvas-relation-create-tab' }
    const relationResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/relations`, {
      method: 'POST', headers: relationCreateHeaders, body: JSON.stringify({ canvasId: canvas.id, srcNodeId: nodeId, dstNodeId: targetNodeId }),
    })
    assert.equal(relationResponse.status, 201)
    const relation = await relationResponse.json() as { id: number; canvasId: number; srcNodeId: number; dstNodeId: number }
    assert.deepEqual(
      (({ id, canvasId, srcNodeId, dstNodeId }) => ({ id, canvasId, srcNodeId, dstNodeId }))(relation),
      {
        id: relation.id, canvasId: canvas.id,
        srcNodeId: Math.min(nodeId, targetNodeId), dstNodeId: Math.max(nodeId, targetNodeId),
      },
    )

    const relationPreview = await fetch(`${undoBase}/preview?context_id=canvas-relation-create-tab`, { headers: relationCreateHeaders })
    assert.equal(relationPreview.status, 200)
    const relationOperation = (await relationPreview.json() as { undo: { operation_id: string } }).undo.operation_id
    const relationBody = JSON.stringify({ operation_id: relationOperation, context_id: 'canvas-relation-create-tab' })
    const foreignRelationHeaders = { ...relationCreateHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
    assert.equal((await fetch(undoBase, { method: 'POST', headers: foreignRelationHeaders, body: relationBody })).status, 404)
    assert.equal((await fetch(undoBase, { method: 'POST', headers: relationCreateHeaders, body: relationBody })).status, 200)
    assert.deepEqual(await (await fetch(`${base}/${canvas.id}/relations`, { headers })).json(), [])
    assert.equal((await fetch(`${undoBase}/redo`, { method: 'POST', headers: relationCreateHeaders, body: relationBody })).status, 200)
    assert.deepEqual((await (await fetch(`${base}/${canvas.id}/relations`, { headers })).json() as Array<{ id: number }>).map(row => row.id), [relation.id])
    const foreignRelation = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/relations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ canvasId: canvas.id, srcNodeId: nodeId, dstNodeId: targetNodeId }),
    })
    assert.equal(foreignRelation.status, 404)

    const duplicateRelationResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/relations`, {
      method: 'POST', headers, body: JSON.stringify({ canvasId: canvas.id, srcNodeId: targetNodeId, dstNodeId: nodeId }),
    })
    assert.equal(duplicateRelationResponse.status, 201)
    assert.equal((await duplicateRelationResponse.json() as { id: number }).id, relation.id)

    const parallelRelationResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/relations`, {
      method: 'POST', headers,
      body: JSON.stringify({ canvasId: canvas.id, srcNodeId: nodeId, dstNodeId: targetNodeId, allowParallel: true }),
    })
    assert.equal(parallelRelationResponse.status, 201)
    const parallelRelation = await parallelRelationResponse.json() as { id: number }
    assert.notEqual(parallelRelation.id, relation.id)

    const invalidSelfRelation = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/relations`, {
      method: 'POST', headers, body: JSON.stringify({ canvasId: canvas.id, srcNodeId: nodeId, dstNodeId: nodeId }),
    })
    assert.equal(invalidSelfRelation.status, 422)

    const wrongCanvasDelete = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/mind/canvases/${canvas.id + 999}/relations/${relation.id}`,
      { method: 'DELETE', headers },
    )
    assert.equal(wrongCanvasDelete.status, 404)
    const beforeDeleteList = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/canvases/${canvas.id}/relations`, { headers })
    assert.deepEqual((await beforeDeleteList.json() as Array<{ id: number }>).map(({ id }) => id), [relation.id, parallelRelation.id])

    const relationDeleteHeaders = { ...headers, 'x-undo-context-id': 'canvas-relation-delete-tab' }
    const foreignRelationDeleteHeaders = { ...relationDeleteHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
    const relationDeleteUrl = `${base}/${canvas.id}/relations/${relation.id}`
    assert.equal((await fetch(relationDeleteUrl, { method: 'DELETE', headers: foreignRelationDeleteHeaders })).status, 404)
    const deleteRelation = await fetch(relationDeleteUrl, { method: 'DELETE', headers: relationDeleteHeaders })
    assert.equal(deleteRelation.status, 204)
    const remainingRelations = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/canvases/${canvas.id}/relations`, { headers })
    assert.deepEqual((await remainingRelations.json() as Array<{ id: number }>).map(({ id }) => id), [parallelRelation.id])
    assert.equal((await fetch(relationDeleteUrl, { method: 'DELETE', headers: relationDeleteHeaders })).status, 404)
    const relationDeletePreview = await fetch(`${undoBase}/preview?context_id=canvas-relation-delete-tab`, { headers: relationDeleteHeaders })
    assert.equal(relationDeletePreview.status, 200)
    const relationDeleteOperation = (await relationDeletePreview.json() as { undo: { operation_id: string } }).undo.operation_id
    const relationDeleteBody = JSON.stringify({ operation_id: relationDeleteOperation, context_id: 'canvas-relation-delete-tab' })
    assert.equal((await fetch(undoBase, { method: 'POST', headers: foreignRelationDeleteHeaders, body: relationDeleteBody })).status, 404)
    assert.equal((await fetch(undoBase, { method: 'POST', headers: relationDeleteHeaders, body: relationDeleteBody })).status, 200)
    assert.deepEqual((await (await fetch(`${base}/${canvas.id}/relations`, { headers })).json() as Array<{ id: number }>).map(row => row.id), [relation.id, parallelRelation.id])
    assert.equal((await fetch(`${undoBase}/redo`, { method: 'POST', headers: relationDeleteHeaders, body: relationDeleteBody })).status, 200)
    assert.deepEqual((await (await fetch(`${base}/${canvas.id}/relations`, { headers })).json() as Array<{ id: number }>).map(row => row.id), [parallelRelation.id])


    const restoredRelationResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/relations`, {
      method: 'POST', headers, body: JSON.stringify({ canvasId: canvas.id, srcNodeId: nodeId, dstNodeId: targetNodeId }),
    })
    assert.equal(restoredRelationResponse.status, 201)
    assert.equal((await restoredRelationResponse.json() as { id: number }).id, relation.id)

    const globalRelationResult = await pool.query<{ id: number | string }>(
      `INSERT INTO mind_relations (
         user_id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key, origin, status, created_at, updated_at, deleted_at
       ) VALUES ($1, NULL, $2, $3, 'related', '', 'user', 'confirmed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
       RETURNING id`,
      [ownerId, nodeId, targetNodeId],
    )
    const globalRelationId = Number(globalRelationResult.rows[0]?.id)
    const foreignGlobalDelete = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/relations/${globalRelationId}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}`,
        'content-type': 'application/json',
      },
    })
    assert.equal(foreignGlobalDelete.status, 404)
    const invalidGlobalDelete = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/relations/invalid`, {
      method: 'DELETE', headers,
    })
    assert.equal(invalidGlobalDelete.status, 422)
    const globalUndoHeaders = { ...headers, 'x-undo-context-id': 'global-relation-delete-tab' }
    const foreignGlobalUndoHeaders = { ...globalUndoHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
    assert.equal((await fetch(`${mindBase}/relations/${relation.id}`, { method: 'DELETE', headers: globalUndoHeaders })).status, 404)
    const globalDelete = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/relations/${globalRelationId}`, {
      method: 'DELETE', headers: globalUndoHeaders,
    })
    assert.equal(globalDelete.status, 204)
    const globalRelationState = await pool.query<{ canvas_id: number | null; deleted_at: Date | null }>(
      'SELECT canvas_id, deleted_at FROM mind_relations WHERE id=$1 AND user_id=$2',
      [globalRelationId, ownerId],
    )
    assert.equal(globalRelationState.rows[0]?.canvas_id, null)
    assert.ok(globalRelationState.rows[0]?.deleted_at)
    const globalRelationUndo = await pool.query<{ before_state: { items: Record<string, { canvas_id: number | null }> } }>(
      `SELECT before_state FROM undo_operations
       WHERE user_id=$1 AND undo_context_id='global-relation-delete-tab' AND target_refs::jsonb @> $2::jsonb`,
      [ownerId, JSON.stringify([{ kind: 'relation', id: globalRelationId }])],
    )
    assert.equal(globalRelationUndo.rows[0]?.before_state.items[`relation:${globalRelationId}`]?.canvas_id, null)
    assert.equal((await fetch(`${mindBase}/relations/${globalRelationId}`, { method: 'DELETE', headers: globalUndoHeaders })).status, 404)
    const globalPreview = await fetch(`${undoBase}/preview?context_id=global-relation-delete-tab`, { headers: globalUndoHeaders })
    assert.equal(globalPreview.status, 200)
    const globalOperation = (await globalPreview.json() as { undo: { operation_id: string } }).undo.operation_id
    const globalUndoBody = JSON.stringify({ operation_id: globalOperation, context_id: 'global-relation-delete-tab' })
    assert.equal((await fetch(undoBase, { method: 'POST', headers: foreignGlobalUndoHeaders, body: globalUndoBody })).status, 404)
    assert.equal((await fetch(undoBase, { method: 'POST', headers: globalUndoHeaders, body: globalUndoBody })).status, 200)
    assert.equal((await pool.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM mind_relations WHERE id=$1 AND user_id=$2', [globalRelationId, ownerId])).rows[0]?.deleted_at, null)
    assert.equal((await fetch(`${undoBase}/redo`, { method: 'POST', headers: globalUndoHeaders, body: globalUndoBody })).status, 200)
    assert.ok((await pool.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM mind_relations WHERE id=$1 AND user_id=$2', [globalRelationId, ownerId])).rows[0]?.deleted_at)


    const update = await fetch(`${base}/${canvas.id}/items/${item.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ x: 44, y: 55 }),
    })
    assert.equal(update.status, 200)
    assert.deepEqual(
      (({ x, y }) => ({ x, y }))(await update.json() as { x: number; y: number }),
      { x: 44, y: 55 },
    )

    const itemUpdateHeaders = { ...headers, 'x-undo-context-id': 'canvas-item-update-empty-tab' }
    const foreignItemUpdateHeaders = { ...itemUpdateHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
    const itemUpdateUrl = `${base}/${canvas.id}/items/${item.id}`
    assert.equal((await fetch(itemUpdateUrl, { method: 'PATCH', headers: foreignItemUpdateHeaders, body: JSON.stringify({ x: 88 }) })).status, 404)
    assert.equal((await fetch(itemUpdateUrl, { method: 'PATCH', headers: itemUpdateHeaders, body: '{}' })).status, 200)
    const emptyUpdateUndo = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM undo_operations WHERE user_id=$1 AND undo_context_id='canvas-item-update-empty-tab'", [ownerId])
    assert.equal(emptyUpdateUndo.rows[0]?.count, 1)
    const frontHeaders = { ...headers, 'x-undo-context-id': 'canvas-item-front-tab' }
    const foreignFrontHeaders = { ...frontHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
    const frontUrl = `${itemUpdateUrl}/bring-to-front`
    assert.equal((await fetch(frontUrl, { method: 'POST', headers: foreignFrontHeaders, body: JSON.stringify({ x: 90, y: 91 }) })).status, 404)
    const frontResponse = await fetch(frontUrl, { method: 'POST', headers: frontHeaders, body: JSON.stringify({ x: 90, y: 91 }) })
    assert.equal(frontResponse.status, 200)
    const frontItem = await frontResponse.json() as { x: number; y: number; z: number }
    assert.deepEqual([frontItem.x, frontItem.y, frontItem.z], [90, 91, 2000])
    async function orderedItems() {
      const response = await fetch(`${base}/${canvas.id}/items`, { headers })
      assert.equal(response.status, 200)
      return await response.json() as Array<{ id: number; x: number; y: number; z: number }>
    }
    const frontPreview = await fetch(`${undoBase}/preview?context_id=canvas-item-front-tab`, { headers: frontHeaders })
    assert.equal(frontPreview.status, 200)
    const frontOperation = (await frontPreview.json() as { undo: { operation_id: string } }).undo.operation_id
    const frontBody = JSON.stringify({ operation_id: frontOperation, context_id: 'canvas-item-front-tab' })
    assert.equal((await fetch(undoBase, { method: 'POST', headers: foreignFrontHeaders, body: frontBody })).status, 404)
    assert.equal((await fetch(undoBase, { method: 'POST', headers: frontHeaders, body: frontBody })).status, 200)
    const unfronted = await orderedItems()
    assert.deepEqual(unfronted.map(row => [row.id, row.z]), [[item.id, 0], [targetItem.id, 1000]])
    assert.equal(unfronted.find(row => row.id === item.id)?.x, 44)
    assert.equal((await fetch(`${undoBase}/redo`, { method: 'POST', headers: frontHeaders, body: frontBody })).status, 200)
    assert.equal((await orderedItems()).find(row => row.id === item.id)?.z, 2000)
    const itemRemoveHeaders = { ...headers, 'x-undo-context-id': 'canvas-item-remove-tab' }
    const foreignItemHeaders = { ...itemRemoveHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
    const itemUrl = `${base}/${canvas.id}/items/${item.id}`
    assert.equal((await fetch(itemUrl, { method: 'DELETE', headers: foreignItemHeaders })).status, 404)
    const remove = await fetch(itemUrl, { method: 'DELETE', headers: itemRemoveHeaders })
    assert.equal(remove.status, 204)
    assert.equal((await fetch(itemUrl, { method: 'DELETE', headers: itemRemoveHeaders })).status, 404)
    const canvasData = await pool.query<{ data_json: string }>('SELECT data_json FROM mind_maps WHERE id=$1 AND user_id=$2', [canvas.id, ownerId])
    assert.deepEqual(JSON.parse(canvasData.rows[0]!.data_json).detachedRelationIds, [relation.id, parallelRelation.id].sort((a, b) => a - b))
    const relationStates = await pool.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM mind_relations WHERE canvas_id=$1 AND user_id=$2 ORDER BY id', [canvas.id, ownerId])
    assert.deepEqual(relationStates.rows.map(row => row.deleted_at), [null, null])
    assert.deepEqual(await (await fetch(`${base}/${canvas.id}/relations`, { headers })).json(), [])
    assert.equal((await fetch(`${base}/${canvas.id}/relations`, { headers: foreignItemHeaders })).status, 404)

    const removePreview = await fetch(`${undoBase}/preview?context_id=canvas-item-remove-tab`, { headers: itemRemoveHeaders })
    assert.equal(removePreview.status, 200)
    const removeOperation = (await removePreview.json() as { undo: { operation_id: string } }).undo.operation_id
    const removeBody = JSON.stringify({ operation_id: removeOperation, context_id: 'canvas-item-remove-tab' })
    assert.equal((await fetch(undoBase, { method: 'POST', headers: foreignItemHeaders, body: removeBody })).status, 404)
    assert.equal((await fetch(undoBase, { method: 'POST', headers: itemRemoveHeaders, body: removeBody })).status, 200)
    const itemAfterUndo = await fetch(`${base}/${canvas.id}/items`, { headers })
    assert.ok((await itemAfterUndo.json() as Array<{ id: number }>).some(row => row.id === item.id))
    assert.equal((await fetch(`${undoBase}/redo`, { method: 'POST', headers: itemRemoveHeaders, body: removeBody })).status, 200)

    const listed = await fetch(`${base}/${canvas.id}/items`, { headers })
    assert.deepEqual((await listed.json() as Array<{ nodeId: number }>).map(({ nodeId: listedNodeId }) => listedNodeId), [targetNodeId])
    const note = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/notes/${nodeId}`, { headers })
    assert.equal(note.status, 200)
    assert.equal((await note.json() as { title: string }).title, '生产组合根记录')
    const canvasNoteCreateHeaders = { ...headers, 'x-undo-context-id': 'canvas-note-create-tab' }
    const foreignCanvasNoteHeaders = { ...canvasNoteCreateHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
    assert.equal((await fetch(`${base}/${canvas.id}/notes`, { method: 'POST', headers: foreignCanvasNoteHeaders, body: '{}' })).status, 404)
    const canvasNoteResponse = await fetch(`${base}/${canvas.id}/notes`, { method: 'POST', headers: canvasNoteCreateHeaders, body: JSON.stringify({ title: '画布内便签', contentMd: '保留正文', x: 12, y: 24 }) })
    assert.equal(canvasNoteResponse.status, 201)
    const canvasNoteItem = await canvasNoteResponse.json() as { nodeId: number }
    const canvasLocationUrl = `${mindBase}/nodes/${canvasNoteItem.nodeId}/canvas-location`
    const canvasLocation = await fetch(canvasLocationUrl, { headers })
    assert.equal(canvasLocation.status, 200)
    assert.deepEqual(await canvasLocation.json(), { canvasId: canvas.id })
    assert.equal((await fetch(canvasLocationUrl, { headers: foreignCanvasNoteHeaders })).status, 404)

    const canvasNoteCreatePreview = await fetch(`${undoBase}/preview?context_id=canvas-note-create-tab`, { headers: canvasNoteCreateHeaders })
    assert.equal(canvasNoteCreatePreview.status, 200)
    const canvasNoteCreateOperation = (await canvasNoteCreatePreview.json() as { undo: { operation_id: string } }).undo.operation_id
    const canvasNoteCreateBody = JSON.stringify({ operation_id: canvasNoteCreateOperation, context_id: 'canvas-note-create-tab' })
    assert.equal((await fetch(undoBase, { method: 'POST', headers: foreignCanvasNoteHeaders, body: canvasNoteCreateBody })).status, 404)
    assert.equal((await fetch(undoBase, { method: 'POST', headers: canvasNoteCreateHeaders, body: canvasNoteCreateBody })).status, 200)
    assert.equal((await (await fetch(`${base}/${canvas.id}/items`, { headers })).json() as Array<{ nodeId: number }>).some(row => row.nodeId === canvasNoteItem.nodeId), false)
    assert.equal((await fetch(`${undoBase}/redo`, { method: 'POST', headers: canvasNoteCreateHeaders, body: canvasNoteCreateBody })).status, 200)
    const currentCanvasNote = (await (await fetch(`${base}/${canvas.id}/items`, { headers })).json() as Array<{ nodeId: number; node: { version: number } }>).find(row => row.nodeId === canvasNoteItem.nodeId)!
    const canvasNoteUpdateHeaders = { ...headers, 'x-undo-context-id': 'canvas-note-update-tab' }
    const foreignCanvasNoteUpdateHeaders = { ...canvasNoteUpdateHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
    const canvasNoteUrl = `${mindBase}/nodes/${canvasNoteItem.nodeId}`
    assert.equal((await fetch(canvasNoteUrl, { method: 'PATCH', headers: foreignCanvasNoteUpdateHeaders, body: JSON.stringify({ version: currentCanvasNote.node.version, title: '越权' }) })).status, 404)
    assert.equal((await fetch(canvasNoteUrl, { method: 'PATCH', headers: canvasNoteUpdateHeaders, body: JSON.stringify({ version: 0, title: '旧版本' }) })).status, 409)
    assert.equal((await fetch(canvasNoteUrl, { method: 'PATCH', headers: canvasNoteUpdateHeaders, body: JSON.stringify({ version: 0 }) })).status, 200)
    assert.equal((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM undo_operations WHERE user_id=$1 AND undo_context_id='canvas-note-update-tab'", [ownerId])).rows[0]?.count, 0)
    const canvasNoteUpdate = await fetch(canvasNoteUrl, { method: 'PATCH', headers: canvasNoteUpdateHeaders, body: JSON.stringify({ version: currentCanvasNote.node.version, contentMd: '**保留正文**' }) })
    assert.equal(canvasNoteUpdate.status, 200)
    assert.equal((await pool.query<{ content_plain: string }>('SELECT content_plain FROM mind_nodes WHERE id=$1 AND user_id=$2', [canvasNoteItem.nodeId, ownerId])).rows[0]?.content_plain, '保留正文')
    const canvasNoteUpdatePreview = await fetch(`${undoBase}/preview?context_id=canvas-note-update-tab`, { headers: canvasNoteUpdateHeaders })
    const canvasNoteUpdateOperation = (await canvasNoteUpdatePreview.json() as { undo: { operation_id: string } }).undo.operation_id
    const canvasNoteUpdateBody = JSON.stringify({ operation_id: canvasNoteUpdateOperation, context_id: 'canvas-note-update-tab' })
    assert.equal((await fetch(undoBase, { method: 'POST', headers: canvasNoteUpdateHeaders, body: canvasNoteUpdateBody })).status, 200)
    assert.equal((await pool.query<{ content_md: string }>('SELECT content_md FROM mind_nodes WHERE id=$1 AND user_id=$2', [canvasNoteItem.nodeId, ownerId])).rows[0]?.content_md, '保留正文')
    assert.equal((await fetch(`${undoBase}/redo`, { method: 'POST', headers: canvasNoteUpdateHeaders, body: canvasNoteUpdateBody })).status, 200)
    assert.equal((await pool.query<{ content_md: string }>('SELECT content_md FROM mind_nodes WHERE id=$1 AND user_id=$2', [canvasNoteItem.nodeId, ownerId])).rows[0]?.content_md, '**保留正文**')

    const canvasNotePatch = await fetch(`${base}/${canvas.id}/items/${(await pool.query<{ id: number }>('SELECT id FROM mind_canvas_items WHERE canvas_id=$1 AND node_id=$2', [canvas.id, canvasNoteItem.nodeId])).rows[0]!.id}`, { method: 'PATCH', headers, body: JSON.stringify({ w: 100, h: 999 }) })
    assert.equal(canvasNotePatch.status, 200)
    const resizedCanvasNote = await canvasNotePatch.json() as { w: number; h: number }
    assert.deepEqual([resizedCanvasNote.w, resizedCanvasNote.h], [180, 420])
    const activeRelationResponse = await fetch(`${mindBase}/relations`, { method: 'POST', headers, body: JSON.stringify({ canvasId: canvas.id, srcNodeId: targetNodeId, dstNodeId: canvasNoteItem.nodeId }) })
    assert.equal(activeRelationResponse.status, 201)
    const activeRelation = await activeRelationResponse.json() as { id: number }
    const deleteHeaders = { ...headers, 'x-undo-context-id': 'main-canvas-delete-tab' }
    const foreignDeleteHeaders = { ...deleteHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
    assert.equal((await fetch(`${base}/${canvas.id}`, { method: 'DELETE', headers: foreignDeleteHeaders })).status, 404)
    assert.equal((await fetch(`${base}/${canvas.id}`, { method: 'DELETE', headers: deleteHeaders })).status, 204)
    assert.equal((await fetch(`${base}/${canvas.id}/items`, { headers })).status, 404)
    assert.equal((await fetch(`${base}/${canvas.id}/relations`, { headers })).status, 404)
    assert.equal((await fetch(canvasLocationUrl, { headers })).status, 404)
    assert.equal((await fetch(`${mindBase}/notes/${nodeId}`, { headers })).status, 200)
    const retainedCanvasNote = await pool.query<{ content_md: string; deleted_at: Date | null }>('SELECT content_md, deleted_at FROM mind_nodes WHERE id=$1 AND user_id=$2', [canvasNoteItem.nodeId, ownerId])
    assert.equal(retainedCanvasNote.rows[0]?.content_md, '**保留正文**')
    assert.equal(retainedCanvasNote.rows[0]?.deleted_at, null)
    const deletePreview = await fetch(`${undoBase}/preview?context_id=main-canvas-delete-tab`, { headers: deleteHeaders })
    assert.equal(deletePreview.status, 200)
    const deleteOperation = (await deletePreview.json() as { undo: { operation_id: string } }).undo.operation_id
    const canvasDeleteBody = JSON.stringify({ operation_id: deleteOperation, context_id: 'main-canvas-delete-tab' })
    assert.equal((await fetch(undoBase, { method: 'POST', headers: foreignDeleteHeaders, body: canvasDeleteBody })).status, 404)
    assert.equal((await fetch(undoBase, { method: 'POST', headers: deleteHeaders, body: canvasDeleteBody })).status, 200)
    const restoredItems = await fetch(`${base}/${canvas.id}/items`, { headers })
    assert.equal(restoredItems.status, 200)
    assert.deepEqual((await restoredItems.json() as Array<{ nodeId: number }>).map(row => row.nodeId).sort((a, b) => a - b), [targetNodeId, canvasNoteItem.nodeId].sort((a, b) => a - b))
    const restoredRelations = await fetch(`${base}/${canvas.id}/relations`, { headers })
    assert.equal(restoredRelations.status, 200)
    assert.deepEqual((await restoredRelations.json() as Array<{ id: number }>).map(row => row.id).sort((a, b) => a - b), [activeRelation.id])
    assert.equal((await fetch(`${undoBase}/redo`, { method: 'POST', headers: deleteHeaders, body: canvasDeleteBody })).status, 200)
    assert.equal((await fetch(`${base}/${canvas.id}/items`, { headers })).status, 404)
    assert.equal((await fetch(`${base}/${canvas.id}/relations`, { headers })).status, 404)
    assert.equal((await fetch(canvasLocationUrl, { headers })).status, 404)
    assert.equal((await fetch(`${mindBase}/notes/${nodeId}`, { headers })).status, 200)
    const redoneNote = await pool.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM mind_nodes WHERE id=$1 AND user_id=$2', [canvasNoteItem.nodeId, ownerId])
    assert.equal(redoneNote.rows[0]?.deleted_at, null)
    const timelineHeaders = { ...headers, 'x-undo-context-id': 'timeline-read-tab' }
    const foreignTimelineHeaders = { ...timelineHeaders, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
    async function createTimeline(contentMd: string, capturedAt: string) {
      const response = await fetch(`${mindBase}/notes`, { method: 'POST', headers: timelineHeaders, body: JSON.stringify({ contentMd, capturedAt }) })
      assert.equal(response.status, 201)
      return await response.json() as { id: number }
    }
    const timelineEarly = await createTimeline('同日先创建', '2020-01-01T12:00:00Z')
    const timelineLater = await createTimeline('同日后创建', '2020-01-01T01:00:00Z')
    const timelineTie = await createTimeline('同秒后创建', '2020-01-01T00:00:00Z')
    await pool.query('UPDATE mind_nodes SET created_at=$1 WHERE id=$2 AND user_id=$3', ['2020-01-02T10:00:00Z', timelineEarly.id, ownerId])
    await pool.query('UPDATE mind_nodes SET created_at=$1 WHERE id=ANY($2::bigint[]) AND user_id=$3', ['2020-01-02T11:00:00Z', [timelineLater.id, timelineTie.id], ownerId])
    const timelineResponse = await fetch(`${mindBase}/notes?limit=200&offset=0`, { headers: timelineHeaders })
    assert.equal(timelineResponse.status, 200)
    const timelineRows = await timelineResponse.json() as Array<{ id: number }>
    const timelineIds = [timelineEarly.id, timelineLater.id, timelineTie.id]
    assert.deepEqual(timelineRows.filter(row => timelineIds.includes(row.id)).map(row => row.id), [timelineTie.id, timelineLater.id, timelineEarly.id])
    const timelineOffset = timelineRows.findIndex(row => row.id === timelineTie.id)
    const timelinePage = await fetch(`${mindBase}/notes?limit=2&offset=${timelineOffset}`, { headers: timelineHeaders })
    assert.deepEqual((await timelinePage.json() as Array<{ id: number }>).map(row => row.id), [timelineTie.id, timelineLater.id])
    assert.equal((await fetch(`${mindBase}/notes/${timelineEarly.id}`, { headers: foreignTimelineHeaders })).status, 404)
    assert.equal((await fetch(`${mindBase}/notes/${canvasNoteItem.nodeId}`, { headers: timelineHeaders })).status, 404)
    assert.equal(timelineRows.some(row => row.id === canvasNoteItem.nodeId), false)
    assert.equal((await fetch(`${mindBase}/notes/${timelineEarly.id}`, { method: 'DELETE', headers: timelineHeaders })).status, 204)
    assert.equal((await fetch(`${mindBase}/notes/${timelineEarly.id}`, { headers: timelineHeaders })).status, 404)
    assert.equal(((await (await fetch(`${mindBase}/notes?limit=200`, { headers: timelineHeaders })).json()) as Array<{ id: number }>).some(row => row.id === timelineEarly.id), false)
    assert.equal((await fetch(`${mindBase}/notes?limit=0`, { headers: timelineHeaders })).status, 422)


  } finally {
    if (previousProxyTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousProxyTarget
    await Promise.all(viteServers.map((vite) => vite.close()))
    await host?.close()
    await pool.end()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await adminPool.end()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
