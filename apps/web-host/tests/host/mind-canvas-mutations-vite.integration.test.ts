import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { after, test } from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'
import { createMindCanvasMutations } from '../../src/domains/mind/application/mind-canvas-mutations.js'
import { createPostgresMindCanvasMutationRuntime } from '../../src/domains/mind/persistence/mind-canvas-mutations-postgres.js'
import { createPostgresMindCanvasReader } from '../../src/domains/mind/mind-canvas-read.js'
import { createMindCanvasNoteMutations } from '../../src/domains/mind/application/mind-canvas-note-mutations.js'
import { createPostgresMindCanvasNoteMutationRuntime } from '../../src/domains/mind/persistence/mind-canvas-note-mutations-postgres.js'
import { createMindCanvasItemMutations } from '../../src/domains/mind/application/mind-canvas-item-mutations.js'
import { createPostgresMindCanvasItemMutationRuntime } from '../../src/domains/mind/persistence/mind-canvas-item-mutations-postgres.js'
import { createPostgresMindNoteReader } from '../../src/domains/mind/mind-notes-read.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = 'b0510e94-10d2-4279-a692-4cff7b4f25cf'
const otherOwnerId = '953aed20-d122-4f1e-9a7f-681899794d24'
const secret = 'synthetic-mind-canvas-vite-secret'
let adminPool: Pool | undefined
let schema: string | undefined
const pools: Pool[] = []
const apps: Array<{ close(): Promise<void> }> = []
const viteServers: Array<{ close(): Promise<void>; httpServer?: { address(): string | { port: number } | null } }> = []

after(async () => {
  await Promise.all(viteServers.splice(0).map((server) => server.close()))
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(pools.splice(0).map((pool) => pool.end()))
  if (adminPool && schema) await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
  await adminPool?.end()
})

test('Vite→Node Host→随机 PostgreSQL schema 创建、编辑并重读画布便签且保留 owner 与 Undo 隔离', {
  skip: !databaseUrl && '需要显式提供 GUGU_WEBUI_TEST_DATABASE_URL 运行隔离 PostgreSQL HTTP 集成',
}, async () => {
  schema = `gugu_mind_canvas_http_${randomUUID().replaceAll('-', '')}`
  adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  pools.push(pool)

  await pool.query(`
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
    CREATE TABLE mind_canvas_items (
      id bigserial PRIMARY KEY, user_id uuid NOT NULL, canvas_id bigint NOT NULL, node_id bigint NOT NULL,
      x double precision NOT NULL, y double precision NOT NULL, w double precision, h double precision,
      z integer NOT NULL, collapsed boolean NOT NULL, data_json text NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz,
      UNIQUE (canvas_id, node_id)
    );
    CREATE TABLE mind_relations (
      id bigserial PRIMARY KEY, user_id uuid NOT NULL, canvas_id bigint NOT NULL,
      src_node_id bigint NOT NULL, dst_node_id bigint NOT NULL, rel_type varchar(32) NOT NULL,
      edge_key varchar(160), origin varchar(16) NOT NULL, status varchar(16) NOT NULL, note text,
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz
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

  const app = createApp({
    appName: '合成 Mind 画布集成测试 Host',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId || id === otherOwnerId ? {
          id, username: 'sample-user', displayName: '示例用户', email: 'sample@example.invalid',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
          imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    mindCanvasReads: createPostgresMindCanvasReader(pool),
    mindNotes: createPostgresMindNoteReader(pool),
    mindCanvasNoteMutations: (() => {
      const service = createMindCanvasNoteMutations(createPostgresMindCanvasNoteMutationRuntime(
        pool,
        async () => {},
      ))
      return {
        create: (id, canvasId, input, metadata) => service.create(id, canvasId, input, {
          undoContextId: metadata.undoContextId,
          clientId: metadata.clientId,
          mutationId: metadata.mutationId,
        }),
        update: (id, nodeId, input, metadata) => service.update(id, nodeId, input, {
          undoContextId: metadata.undoContextId,
          clientId: metadata.clientId,
          mutationId: metadata.mutationId,
        }),
      }
    })(),
    mindCanvasItemMutations: (() => {
      const service = createMindCanvasItemMutations(createPostgresMindCanvasItemMutationRuntime(
        pool,
        async () => {},
      ))
      return {
        add: (id, canvasId, input, metadata) => service.add(id, canvasId, input, {
          undoContextId: metadata.undoContextId,
          clientId: metadata.clientId,
          mutationId: metadata.mutationId,
        }),
        update: (id, canvasId, itemId, input, metadata) => service.update(id, canvasId, itemId, input, {
          undoContextId: metadata.undoContextId,
          clientId: metadata.clientId,
          mutationId: metadata.mutationId,
        }),
        bringToFront: (id, canvasId, itemId, input, metadata) => service.bringToFront(id, canvasId, itemId, input, {
          undoContextId: metadata.undoContextId,
          clientId: metadata.clientId,
          mutationId: metadata.mutationId,
        }),
        remove: (id, canvasId, itemId, metadata) => service.remove(id, canvasId, itemId, {
          undoContextId: metadata.undoContextId,
          clientId: metadata.clientId,
          mutationId: metadata.mutationId,
        }),
      }
    })(),
    mindCanvasMutations: (() => {
      const service = createMindCanvasMutations(createPostgresMindCanvasMutationRuntime(
        pool,
        async () => {},
      ))
      return {
        create: (id, input, metadata) => service.create(id, input, {
          undoContextId: metadata.undoContextId,
          clientId: metadata.clientId,
        }),
        update: (id, canvasId, input, metadata) => service.update(id, canvasId, input, {
          undoContextId: metadata.undoContextId,
          clientId: metadata.clientId,
        }),
        delete: (id, canvasId, metadata) => service.delete(id, canvasId, {
          undoContextId: metadata.undoContextId,
          clientId: metadata.clientId,
        }),
      }
    })(),
  })
  apps.push(app)
  const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
  const previousTarget = process.env.VITE_API_PROXY_TARGET
  process.env.VITE_API_PROXY_TARGET = hostAddress

  try {
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
    const origin = new URL(base).origin
    const ownerHeaders = {
      authorization: `Bearer ${createUserToken(ownerId, 1, secret)}`,
      'content-type': 'application/json',
      'x-undo-context-id': 'vite-mind-canvas-tab',
      'x-client-id': 'vite-mind-canvas-client',
    }
    const otherHeaders = {
      authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}`,
      'content-type': 'application/json',
    }

    assert.equal((await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401)
    const created = await fetch(base, {
      method: 'POST', headers: ownerHeaders, body: JSON.stringify({ title: '工作计划' }),
    })
    assert.equal(created.status, 201)
    const initial = await created.json() as { id: number; title: string; projectId: number | null; data: object }
    assert.deepEqual({ title: initial.title, projectId: initial.projectId, data: initial.data }, {
      title: '工作计划', projectId: null, data: {},
    })

    const updatedResponse = await fetch(`${base}/${initial.id}`, {
      method: 'PATCH', headers: ownerHeaders,
      body: JSON.stringify({ title: '  调整后的计划  ', data: { x: 24, y: -18, scale: 1.25 } }),
    })
    assert.equal(updatedResponse.status, 200)
    const updated = await updatedResponse.json() as { title: string; data: Record<string, number> }
    assert.equal(updated.title, '调整后的计划')
    assert.deepEqual(updated.data, { x: 24, y: -18, scale: 1.25 })

    const createdNoteResponse = await fetch(`${base}/${initial.id}/notes`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ title: '  独立便签  ', contentMd: '# 待办\n\n- 完成画布', color: 'blue', x: 12, y: 24, w: 120, h: 80 }),
    })
    assert.equal(createdNoteResponse.status, 201)
    const createdNote = await createdNoteResponse.json() as {
      id: number; x: number; y: number; w: number; h: number; node: { id: number; title: string; kind: string; version: number; contentMd: string; color: string }
    }
    assert.deepEqual({ title: createdNote.node.title, kind: createdNote.node.kind, version: createdNote.node.version, w: createdNote.w, h: createdNote.h }, {
      title: '独立便签', kind: 'canvas_note', version: 1, w: 180, h: 100,
    })

    const editedNoteResponse = await fetch(`${origin}/api/v1/mind/nodes/${createdNote.node.id}`, {
      method: 'PATCH', headers: ownerHeaders,
      body: JSON.stringify({ version: 1, title: '已完成', contentMd: '## 已更新', color: 'teal' }),
    })
    assert.equal(editedNoteResponse.status, 200)
    const editedNote = await editedNoteResponse.json() as {
      id: number; kind: string; title: string; contentMd: string; color: string; version: number;
      capturedAt: string; createdAt: string; updatedAt: string; deletedAt: null;
      refType: null; refId: null; refSnapshot: null;
    }
    assert.deepEqual(editedNote, {
      id: createdNote.node.id, kind: 'canvas_note', title: '已完成', contentMd: '## 已更新', color: 'teal',
      capturedAt: editedNote.capturedAt, version: 2, createdAt: editedNote.createdAt,
      updatedAt: editedNote.updatedAt, deletedAt: null, refType: null, refId: null, refSnapshot: null,
    })
    const staleEdit = await fetch(`${origin}/api/v1/mind/nodes/${createdNote.node.id}`, {
      method: 'PATCH', headers: ownerHeaders, body: JSON.stringify({ version: 1, contentMd: '覆盖' }),
    })
    assert.equal(staleEdit.status, 409)
    const foreignEdit = await fetch(`${origin}/api/v1/mind/nodes/${createdNote.node.id}`, {
      method: 'PATCH', headers: otherHeaders, body: JSON.stringify({ version: 2, contentMd: '越权' }),
    })
    assert.equal(foreignEdit.status, 404)

    const now = new Date().toISOString()
    const ordinaryNoteResult = await pool.query<{ id: number | string }>(
      `INSERT INTO mind_nodes (
         user_id, kind, title, content_md, content_plain, color, ref_type, ref_id, ref_snapshot,
         origin, indexed_at, indexed_hash, version, captured_at, created_at, updated_at, deleted_at
       ) VALUES ($1, 'note', '普通记录', '保留原始记录', '保留原始记录', NULL, NULL, NULL, NULL,
         'web', NULL, NULL, 1, $2, $2, $2, NULL) RETURNING id`,
      [ownerId, now],
    )
    const ordinaryNoteId = Number(ordinaryNoteResult.rows[0]?.id)
    assert.ok(ordinaryNoteId > 0)
    const addedResponse = await fetch(`${base}/${initial.id}/items`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ nodeId: ordinaryNoteId, x: 14, y: 28, w: 280, h: 160, z: 0, data: { color: 'blue' } }),
    })
    assert.equal(addedResponse.status, 201)
    const added = await addedResponse.json() as { id: number; nodeId: number; x: number; y: number; z: number; data: object }
    assert.deepEqual({ nodeId: added.nodeId, x: added.x, y: added.y, data: added.data }, {
      nodeId: ordinaryNoteId, x: 14, y: 28, data: { color: 'blue' },
    })
    const duplicateAdd = await fetch(`${base}/${initial.id}/items`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ nodeId: ordinaryNoteId, x: 999, y: 999 }),
    })
    assert.equal(duplicateAdd.status, 201)
    assert.equal((await duplicateAdd.json() as { id: number }).id, added.id)

    await pool.query(
      `INSERT INTO mind_relations (
         user_id, canvas_id, src_node_id, dst_node_id, rel_type, origin, status, created_at, updated_at, deleted_at
       ) VALUES ($1, $2, $3, $4, 'related', 'web', 'active', $5, $5, NULL)`,
      [ownerId, initial.id, createdNote.node.id, ordinaryNoteId, now],
    )
    const editedItemResponse = await fetch(`${base}/${initial.id}/items/${added.id}`, {
      method: 'PATCH', headers: ownerHeaders,
      body: JSON.stringify({ x: 30, y: 45, data: { color: 'teal' } }),
    })
    assert.equal(editedItemResponse.status, 200)
    const editedItem = await editedItemResponse.json() as { x: number; y: number; data: object }
    assert.deepEqual({ x: editedItem.x, y: editedItem.y, data: editedItem.data }, {
      x: 30, y: 45, data: { color: 'teal' },
    })

    const frontResponse = await fetch(`${base}/${initial.id}/items/${createdNote.id}/bring-to-front`, {
      method: 'POST', headers: ownerHeaders, body: JSON.stringify({ x: 80, y: 90 }),
    })
    assert.equal(frontResponse.status, 200)
    const front = await frontResponse.json() as { x: number; y: number; z: number }
    assert.deepEqual({ x: front.x, y: front.y, z: front.z }, { x: 80, y: 90, z: 2000 })

    const removedResponse = await fetch(`${base}/${initial.id}/items/${added.id}`, {
      method: 'DELETE', headers: ownerHeaders,
    })
    assert.equal(removedResponse.status, 204)
    const remainingItems = await fetch(`${base}/${initial.id}/items`, { headers: ownerHeaders })
    assert.deepEqual((await remainingItems.json() as Array<{ id: number }>).map(({ id }) => id), [createdNote.id])
    const relations = await fetch(`${origin}/api/v1/mind/canvases/${initial.id}/relations`, { headers: ownerHeaders })
    assert.deepEqual(await relations.json(), [])
    const remainingNote = await fetch(`${origin}/api/v1/mind/notes/${ordinaryNoteId}`, { headers: ownerHeaders })
    assert.equal(remainingNote.status, 200)
    assert.equal((await remainingNote.json() as { title: string }).title, '普通记录')
    const listedItems = await fetch(`${base}/${initial.id}/items`, { headers: ownerHeaders })
    assert.equal(listedItems.status, 200)
    const listedNote = (await listedItems.json() as Array<{ id: number; node: {
      id: number; kind: string; title: string; contentMd: string; color: string; version: number;
      capturedAt: string; createdAt: string; updatedAt: string; deletedAt: null;
      refType: null; refId: null; refSnapshot: null;
    } }>)[0]
    assert.deepEqual(listedNote?.node, {
      id: createdNote.node.id, kind: 'canvas_note', title: '已完成', contentMd: '## 已更新', color: 'teal',
      capturedAt: listedNote?.node.capturedAt, version: 2, createdAt: listedNote?.node.createdAt,
      updatedAt: listedNote?.node.updatedAt, deletedAt: null, refType: null, refId: null, refSnapshot: null,
    })
    const timelineNotes = await fetch(`${origin}/api/v1/mind/notes`, { headers: ownerHeaders })
    assert.deepEqual((await timelineNotes.json() as Array<{ id: number }>).map(({ id }) => id), [ordinaryNoteId])

    const ownedList = await fetch(base, { headers: ownerHeaders })
    assert.deepEqual((await ownedList.json() as Array<{ id: number; title: string }>).map(({ id, title }) => ({ id, title })), [
      { id: initial.id, title: '调整后的计划' },
    ])
    const otherList = await fetch(base, { headers: otherHeaders })
    assert.deepEqual(await otherList.json(), [])
    const hiddenUpdate = await fetch(`${base}/${initial.id}`, {
      method: 'PATCH', headers: otherHeaders, body: JSON.stringify({ title: '越权写入' }),
    })
    assert.equal(hiddenUpdate.status, 404)
    const hiddenDelete = await fetch(`${base}/${initial.id}`, { method: 'DELETE', headers: otherHeaders })
    assert.equal(hiddenDelete.status, 404)
    const deletedCanvas = await fetch(`${base}/${initial.id}`, { method: 'DELETE', headers: ownerHeaders })
    assert.equal(deletedCanvas.status, 204)
    const deletedCanvasList = await fetch(base, { headers: ownerHeaders })
    assert.deepEqual(await deletedCanvasList.json(), [])
    const childRows = await pool.query<{ active_items: string; active_relations: string; note_deleted_at: Date | null }>(
      `SELECT
         (SELECT count(*) FROM mind_canvas_items WHERE canvas_id=$1 AND deleted_at IS NULL)::text AS active_items,
         (SELECT count(*) FROM mind_relations WHERE canvas_id=$1 AND deleted_at IS NULL)::text AS active_relations,
         (SELECT deleted_at FROM mind_nodes WHERE id=$2) AS note_deleted_at`,
      [initial.id, createdNote.node.id],
    )
    assert.deepEqual(childRows.rows[0], { active_items: '0', active_relations: '0', note_deleted_at: null })
    const undo = await pool.query<{ action: string; actor_type: string; before_state: { items: Record<string, unknown> }; after_state: { items: Record<string, unknown> } }>(
      'SELECT action, actor_type, before_state, after_state FROM undo_operations WHERE user_id=$1 ORDER BY created_at', [ownerId],
    )
    assert.equal(undo.rows.length, 9)
    assert.ok(undo.rows.every(({ actor_type }) => actor_type === 'web'))
    assert.deepEqual(undo.rows.reduce<Record<string, number>>((counts, { action }) => {
      counts[action] = (counts[action] ?? 0) + 1
      return counts
    }, {}), { create: 3, update: 4, delete: 2 })
    const canvasDeleteUndo = undo.rows.at(-1)
    assert.ok(canvasDeleteUndo)
    assert.ok('canvas:' + initial.id in canvasDeleteUndo.before_state.items)
    assert.ok('canvas_item:' + createdNote.id in canvasDeleteUndo.before_state.items)
    assert.ok('relation:' + 1 in canvasDeleteUndo.before_state.items)
    assert.ok('canvas_note:' + createdNote.node.id in canvasDeleteUndo.before_state.items)
    assert.equal((canvasDeleteUndo.after_state.items[`canvas_note:${createdNote.node.id}`] as { deleted_at: null }).deleted_at, null)
  } finally {
    if (previousTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousTarget
  }
})
