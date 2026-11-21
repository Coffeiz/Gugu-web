import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createImProductionFixture} from './production.fixtures.js'
import {assertImHostSchema} from '../../../src/modules/im/gateway/host-settings.js'
import {createGatewayBotConfig} from '../../../src/modules/im/gateway/bot-config.js'

const python=process.env.GUGU_IM_ORM_PYTHON,url=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('真实Python ORM离线DDL+Node显式schema可供正式Core PG/可信Bot读取；只在随机schema与临时配置创建合成记录',{
 skip:(!python||!url)&&'需要显式隔离PG和Python解释器',timeout:120000,
},async()=>{
 const fixture=await createImProductionFixture({python:python!})
 try{
  await assertImHostSchema(fixture.pool)
  await fixture.pool.query("ALTER TABLE gugu_im_platform_projection DROP CONSTRAINT gugu_im_platform_projection_platform_check; ALTER TABLE gugu_im_platform_projection ADD CONSTRAINT gugu_im_platform_projection_platform_check CHECK (platform='feishu')")
  await assert.rejects(assertImHostSchema(fixture.pool),{message:'Node IM 数据库迁移尚未就绪'})
  const types=(await fixture.pool.query("SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='conversation_sessions' AND column_name='bot_id'",[fixture.schema])).rows
  assert.equal(types[0]?.data_type,'character varying')
  const reader=createGatewayBotConfig({pool:fixture.pool,secretKey:fixture.secretKey,normalizeOwner:id=>id,supportedPlatforms:()=>['telegram']})
  const bots=await reader.read()
  assert.equal(bots.length,1);assert.equal(bots[0]?.owner,fixture.ownerId);assert.equal(bots[0]?.id,fixture.botId)
  const session=await fixture.insert('conversation_sessions',{user_id:fixture.ownerId,title:'合成生产消息',source:'telegram',bot_id:fixture.botId,chat_type:'c2c',platform_user_id:'202'})
  assert.equal(session.user_id,fixture.ownerId)
  assert.equal((await fixture.pool.query('SELECT count(*)::integer AS count FROM users')).rows[0]?.count,2)
  assert.equal(fixture.core.backend,'postgres')
 }finally{await fixture.close()}
})
