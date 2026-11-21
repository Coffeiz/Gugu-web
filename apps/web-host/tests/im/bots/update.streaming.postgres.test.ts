import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createPostgresRuntime } from '../../../../../packages/core/src/data/postgres.js'
import { createUserBotUpdater } from '../../../../../packages/core/src/im/user-bot-update.js'

test('QQ、飞书和 Telegram 私聊流式开关默认开启并能持久化更新，微信拒绝该设置', async () => {
  const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
  assert.ok(url, '需要显式隔离 PostgreSQL 测试库')
  const schema = `im_stream_settings_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 2 })
  const runtime = await createPostgresRuntime({ url, schema, maxConnections: 2 })

  try {
    await pool.query(`CREATE TABLE user_bots (
      id serial PRIMARY KEY, user_id uuid NOT NULL, platform text NOT NULL, name text NOT NULL,
      app_id text NOT NULL, app_secret text NOT NULL, sandbox boolean NOT NULL DEFAULT false,
      enabled boolean NOT NULL DEFAULT true, group_chat_enabled boolean NOT NULL DEFAULT false,
      feishu_group_chat_enabled boolean, group_requires_at boolean NOT NULL DEFAULT true,
      group_read_enabled boolean NOT NULL DEFAULT false, group_memory_enabled boolean NOT NULL DEFAULT true,
      group_owner_memory_enabled boolean NOT NULL DEFAULT false, member_memory_enabled boolean NOT NULL DEFAULT true,
      group_attention_mode text NOT NULL DEFAULT 'autonomous', group_attention_config_version integer NOT NULL DEFAULT 0,
      group_allowed_tools jsonb NOT NULL DEFAULT '[]'::jsonb, group_message_format text,
      private_message_format text, private_streaming_enabled boolean, owner_platform_user_id text
    )`)

    const owner = randomUUID()
    const ids = new Map<string, number>()
    for (const platform of ['qq', 'feishu', 'telegram', 'wechat']) {
      const result = await pool.query<{ id: number }>(`INSERT INTO user_bots
        (user_id, platform, name, app_id, app_secret, group_allowed_tools, private_message_format)
        VALUES ($1, $2, $3, $4, 'synthetic-secret', '[]'::jsonb, 'markdown') RETURNING id`,
      [owner, platform, `${platform} test bot`, `synthetic-${platform}`])
      ids.set(platform, result.rows[0]!.id)
    }

    let publications = 0
    const update = createUserBotUpdater(runtime.db, {
      encrypt: value => `encrypted:${value}`,
      decrypt: value => value,
      publishChanged: async () => { publications++ },
    })

    for (const platform of ['qq', 'feishu', 'telegram']) {
      const id = ids.get(platform)!
      const defaultProjection = await update(owner, id, { name: `${platform} default` })
      assert.equal(defaultProjection.private_streaming_enabled, true, `${platform} 缺省开启`)

      assert.equal((await update(owner, id, { private_streaming_enabled: false })).private_streaming_enabled, false)
      assert.equal((await pool.query('SELECT private_streaming_enabled FROM user_bots WHERE id=$1', [id])).rows[0]!.private_streaming_enabled, false)
      assert.equal((await update(owner, id, { private_streaming_enabled: true })).private_streaming_enabled, true)
      assert.equal((await pool.query('SELECT private_streaming_enabled FROM user_bots WHERE id=$1', [id])).rows[0]!.private_streaming_enabled, true)
    }

    await assert.rejects(() => update(owner, ids.get('wechat')!, { private_streaming_enabled: false }), /该平台不支持私聊流式传输/)
    assert.equal(publications, 9)
  } finally {
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
