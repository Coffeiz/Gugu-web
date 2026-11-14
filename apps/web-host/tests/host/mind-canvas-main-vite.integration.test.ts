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
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz
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
    const eventRef = await eventRefResponse.json() as { refSnapshot: Record<string, unknown> }
    assert.deepEqual(eventRef.refSnapshot, { date: '2026-11-14', time: '09:30', endTime: '10:15' })

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

    const relationResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/relations`, {
      method: 'POST', headers, body: JSON.stringify({ canvasId: canvas.id, srcNodeId: nodeId, dstNodeId: targetNodeId }),
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

    const deleteRelation = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/mind/canvases/${canvas.id}/relations/${relation.id}`,
      { method: 'DELETE', headers },
    )
    assert.equal(deleteRelation.status, 204)
    const remainingRelations = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/canvases/${canvas.id}/relations`, { headers })
    assert.deepEqual((await remainingRelations.json() as Array<{ id: number }>).map(({ id }) => id), [parallelRelation.id])

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
    const globalDelete = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/relations/${globalRelationId}`, {
      method: 'DELETE', headers,
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
       WHERE user_id=$1 AND undo_context_id='main-mind-tab' AND target_refs::jsonb @> $2::jsonb`,
      [ownerId, JSON.stringify([{ kind: 'relation', id: globalRelationId }])],
    )
    assert.equal(globalRelationUndo.rows[0]?.before_state.items[`relation:${globalRelationId}`]?.canvas_id, null)

    const update = await fetch(`${base}/${canvas.id}/items/${item.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ x: 44, y: 55 }),
    })
    assert.equal(update.status, 200)
    assert.deepEqual(
      (({ x, y }) => ({ x, y }))(await update.json() as { x: number; y: number }),
      { x: 44, y: 55 },
    )

    const remove = await fetch(`${base}/${canvas.id}/items/${item.id}`, { method: 'DELETE', headers })
    assert.equal(remove.status, 204)
    const listed = await fetch(`${base}/${canvas.id}/items`, { headers })
    assert.deepEqual((await listed.json() as Array<{ nodeId: number }>).map(({ nodeId: listedNodeId }) => listedNodeId), [targetNodeId])
    const note = await fetch(`http://127.0.0.1:${address.port}/api/v1/mind/notes/${nodeId}`, { headers })
    assert.equal(note.status, 200)
    assert.equal((await note.json() as { title: string }).title, '生产组合根记录')
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
