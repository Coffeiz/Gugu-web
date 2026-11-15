import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerUserSkillManagementRoutes} from '../../src/modules/agent-skills/user-management.js'

test('用户技能目录显式按需发现工具并保护认证，写入不接受伪造 owner',async()=>{
 const app=Fastify({routerOptions:{ignoreTrailingSlash:true}});let discoveries=0,owner=''
 registerUserSkillManagementRoutes(app,{requireUser:async req=>{if(req.headers.authorization!=='user')throw Object.assign(new Error('未授权'),{statusCode:401})},ownerIdFromRequest:()=> 'trusted',operations:{list:async id=>{owner=id;return []},create:async(id,input)=>{owner=id;return {id:'U1',...input,source:'user',managed_by:'user',content_digest:'synthetic-digest',created_at:null,updated_at:null,enabled:input.enabled??true}},update:async()=>({id:'U1'} as never)},tools:async()=>{discoveries++;return [{name:'web_search',description_short:'搜索',category:'web',enabled:true}]}})
 try{
  assert.equal((await app.inject({method:'GET',url:'/api/v1/skills/'})).statusCode,401)
  const simple=await app.inject({method:'GET',url:'/api/v1/skills/?include_tools=false',headers:{authorization:'user'}});assert.deepEqual(simple.json(),{skills:[],tools:[]});assert.equal(discoveries,0)
  const full=await app.inject({method:'GET',url:'/api/v1/skills/',headers:{authorization:'user'}});assert.equal(full.json().tools[0].name,'web_search');assert.equal(discoveries,1)
  const response=await app.inject({method:'POST',url:'/api/v1/skills/',headers:{authorization:'user'},payload:{name:'合成',description_short:'摘要',body:'正文',enabled:'false',owner_id:'forged'}});assert.equal(response.statusCode,201);assert.equal(owner,'trusted');assert.equal(response.json().enabled,false)
  const unicode=await app.inject({method:'POST',url:'/api/v1/skills/',headers:{authorization:'user'},payload:{name:'合成',description_short:'摘要',description_long:'😀'.repeat(500),body:'正文'}});assert.equal(unicode.statusCode,201)
 }finally{await app.close()}
})
