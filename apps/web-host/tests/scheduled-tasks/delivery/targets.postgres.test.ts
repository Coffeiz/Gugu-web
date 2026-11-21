import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createScheduledTaskDeliveryTargets } from '../../../src/modules/scheduled-tasks/delivery/targets.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('投递目标按用户和启用的 Bot 隔离，并优先保留最近群会话', { skip: !url }, async () => {
  const admin = new Pool({ connectionString: url })
  const schema = `gugu_targets_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const owner = randomUUID(), other = randomUUID()
  try {
    await pool.query(`CREATE TABLE user_bots(id integer,user_id uuid,platform text,enabled boolean,owner_platform_user_id text);
      CREATE TABLE conversation_sessions(id integer,user_id uuid,source text,chat_type text,chat_id text,title text,bot_id text)`)
    await pool.query(`INSERT INTO user_bots VALUES(1,$1,'qq',true,NULL),(2,$1,'feishu',false,'x'),(3,$2,'qq',true,'other')`, [owner, other])
    await pool.query(`INSERT INTO conversation_sessions VALUES
      (1,$1,'qq','group','a','旧名称','1'),(2,$1,'qq','group','a','新名称','1'),
      (3,$1,'qq','group','b',NULL,'9'),(4,$2,'qq','group','secret','不应出现','3'),
      (5,$1,'qq','c2c','private','私聊','1'),(6,$1,'qq','group',NULL,'空','1')`, [owner, other])
    const targets = createScheduledTaskDeliveryTargets(pool)
    assert.deepEqual(await targets.qq(owner), { groups: [{ chat_id: 'b', title: '未命名群会话' }, { chat_id: 'a', title: '新名称' }] })
    assert.deepEqual(await targets.platform(owner, 'qq'), { private_available: true, groups: [{ chat_id: 'a', title: '新名称' }] })
    assert.deepEqual(await targets.platform(owner, 'feishu'), { private_available: false, groups: [] })
    assert.equal(await targets.platform(owner, 'wechat'), null)
    assert.deepEqual(await targets.qq(other), { groups: [{ chat_id: 'secret', title: '不应出现' }] })
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
