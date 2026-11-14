import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresMindCanvasReader } from '../../src/domains/mind/mind-canvas-read.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('canvas reader scopes canvases, active nodes, event snapshots, and relations in isolated PostgreSQL', {
  skip: !databaseUrl && '需要显式提供隔离 PostgreSQL 测试地址',
}, async () => {
  const schema = `gugu_mind_canvas_read_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const ownerId = randomUUID()
  const otherOwnerId = randomUUID()
  const now = new Date('2026-11-14T01:02:03.000Z')

  try {
    await pool.query(`
      CREATE TABLE mind_maps (
        id bigserial PRIMARY KEY, user_id uuid NOT NULL, title text NOT NULL, project_id bigint,
        data_json text NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
        deleted_at timestamptz
      );
      CREATE TABLE mind_nodes (
        id bigserial PRIMARY KEY, user_id uuid NOT NULL, kind text NOT NULL, title text, content_md text,
        color text, captured_at timestamptz NOT NULL, version integer NOT NULL, created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL, deleted_at timestamptz, ref_type text, ref_id bigint, ref_snapshot jsonb
      );
      CREATE TABLE mind_canvas_items (
        id bigserial PRIMARY KEY, user_id uuid NOT NULL, canvas_id bigint NOT NULL, node_id bigint NOT NULL,
        x double precision NOT NULL, y double precision NOT NULL, w double precision, h double precision,
        z integer NOT NULL, collapsed boolean NOT NULL, data_json text NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE calendar_events (
        id bigserial PRIMARY KEY, user_id uuid NOT NULL, date date NOT NULL, time text, end_time text,
        description text, deleted_at timestamptz
      );
      CREATE TABLE mind_relations (
        id bigserial PRIMARY KEY, user_id uuid NOT NULL, canvas_id bigint, src_node_id bigint NOT NULL,
        dst_node_id bigint NOT NULL, rel_type text NOT NULL, origin text NOT NULL, status text NOT NULL,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz
      );
    `)
    await pool.query(`
      INSERT INTO mind_maps (id, user_id, title, project_id, data_json, created_at, updated_at) VALUES
        (1, $1, '自有画布', 4, '{"detachedRelationIds":[12]}', $3, $3),
        (2, $2, '他人画布', 4, '{}', $3, $3),
        (3, $1, '已删除画布', 4, '{}', $3, $3)
    `, [ownerId, otherOwnerId, now])
    await pool.query('UPDATE mind_maps SET deleted_at=$1 WHERE id=3', [now])
    await pool.query(`
      INSERT INTO mind_nodes (id, user_id, kind, title, content_md, captured_at, version, created_at, updated_at, ref_type, ref_id)
      VALUES
        (1, $1, 'ref', '活动', '', $3, 1, $3, $3, 'event', 5),
        (2, $1, 'canvas_note', '软删便签', '', $3, 1, $3, $3, NULL, NULL),
        (3, $2, 'canvas_note', '他人便签', '', $3, 1, $3, $3, NULL, NULL),
        (4, $1, 'canvas_note', '自有画布便签', '', $3, 1, $3, $3, NULL, NULL)
    `, [ownerId, otherOwnerId, now])
    await pool.query('UPDATE mind_nodes SET deleted_at=$1 WHERE id=2', [now])
    await pool.query(`
      INSERT INTO mind_canvas_items (id, user_id, canvas_id, node_id, x, y, z, collapsed, data_json, created_at, updated_at)
      VALUES
        (1, $1, 1, 1, 12, 24, 1, false, '{}', $3, $3),
        (2, $1, 1, 2, 0, 0, 2, false, '{}', $3, $3),
        (3, $2, 1, 3, 0, 0, 3, false, '{}', $3, $3),
        (4, $1, 1, 4, 0, 0, 4, false, '{}', $3, $3)
    `, [ownerId, otherOwnerId, now])
    await pool.query(`INSERT INTO calendar_events (id, user_id, date, time, end_time, description) VALUES (5, $1, '2026-11-15', '09:00', '10:00', '评审')`, [ownerId])
    await pool.query(`
      INSERT INTO mind_relations (id, user_id, canvas_id, src_node_id, dst_node_id, rel_type, origin, status, created_at, updated_at)
      VALUES
        (11, $1, 1, 1, 2, 'related', 'user', 'confirmed', $3, $3),
        (12, $1, 1, 1, 2, 'related', 'gugu', 'suggested', $3, $3),
        (13, $2, 1, 1, 2, 'related', 'user', 'confirmed', $3, $3)
    `, [ownerId, otherOwnerId, now])

    const reader = createPostgresMindCanvasReader(pool)
    const canvases = await reader.listCanvases(ownerId, 4)
    const items = await reader.listItems(ownerId, 1)
    const relations = await reader.listRelations(ownerId, 1)
    const canvasLocation = await reader.canvasLocation(ownerId, 4)

    assert.deepEqual(canvases.map((canvas) => canvas.title), ['自有画布'])
    assert.equal(canvases[0]?.data.detachedRelationIds instanceof Array, true)
    assert.deepEqual(items?.map((item) => item.nodeId), [1])
    assert.deepEqual(items?.[0]?.refData, { date: '2026-11-15', time: '09:00', endTime: '10:00', description: '评审' })
    assert.deepEqual(relations?.map((relation) => relation.id), [11])
    assert.equal(canvasLocation, 1)
    assert.equal(await reader.canvasLocation(otherOwnerId, 4), null)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
