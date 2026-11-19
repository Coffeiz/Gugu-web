import assert from 'node:assert/strict'
import test from 'node:test'
import { createKyselyOnboardingStore, onboardingResponse } from '@gugu/core/onboarding'
import { resetOnboardingGuide } from '@gugu/core/onboarding'
import { Pool } from 'pg'
import { createPostgresRuntime } from '@gugu/core/data'
import { randomUUID } from 'node:crypto'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('重置仅清空当前owner引导进度并保留播种和扩展状态', { skip: !databaseUrl && '需要隔离PostgreSQL' }, async () => {
  const schema = `onboarding_reset_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({connectionString:databaseUrl,max:1})
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:1})
  const runtime = await createPostgresRuntime({url:databaseUrl!,schema})
  const first = '00000000-0000-4000-8000-000000000051', second = '00000000-0000-4000-8000-000000000052'
  const state = {seed:{seeded:true,project_id:'synthetic-project',project_name:'欢迎'},guide:{enabled:false,version:2,current_step:'complete',completed_steps:['locale'],dismissed:true,completed_at:'2026-11-14',extra:'保留'},extra:'保留'}
  try {
    await pool.query('CREATE TABLE onboarding_state(user_id uuid PRIMARY KEY,state json NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL)')
    for (const id of [first,second]) await pool.query('INSERT INTO onboarding_state VALUES($1,$2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',[id,JSON.stringify(state)])
    const store = createKyselyOnboardingStore(runtime.db,'postgres')
    const result = await resetOnboardingGuide(store,first)
    assert.equal(result.ok,true)
    assert.deepEqual(result.state.seed,state.seed)
    assert.deepEqual(result.state.guide,{enabled:true,version:1,current_step:'locale',completed_steps:[],dismissed:false,completed_at:null,extra:'保留',should_show:true})
    assert.equal(result.state.extra,'保留')
    assert.deepEqual(onboardingResponse(await store.getState(first)),result.state)
    const other = await store.getState(second)
    assert.equal((other.guide as Record<string,unknown>).dismissed,true)
    assert.deepEqual(other.seed,state.seed)
  } finally { await runtime.close(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})

import Fastify from 'fastify'
import { registerOnboardingResetGuideRoute } from '../../src/modules/onboarding/routes.js'

test('引导重置HTTP未认证不调用用例，认证后只采用可信owner', async () => {
  const app = Fastify()
  let changedOwner = ''
  registerOnboardingResetGuideRoute(app, {
    requireUser: async (request,reply) => { if(request.headers.authorization!=='user') return reply.code(401).send({detail:'未授权'}) },
    ownerIdFromRequest: () => 'trusted-owner',
    store: {getState:async()=>({}), updateGuide:async(owner,patch)=>{changedOwner=owner;return {seed:{seeded:true},guide:patch}}},
  })
  try {
    assert.equal((await app.inject({method:'POST',url:'/api/v1/onboarding/dev/reset-guide'})).statusCode,401)
    assert.equal(changedOwner,'')
    const response = await app.inject({method:'POST',url:'/api/v1/onboarding/dev/reset-guide',headers:{authorization:'user'},payload:{ownerId:'untrusted-owner'}})
    assert.equal(response.statusCode,200)
    assert.equal(changedOwner,'trusted-owner')
    assert.equal(response.json().state.should_show,true)
    assert.equal(response.json().state.seed.seeded,true)
  } finally {await app.close()}
})
