import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import type {createUserBotUpdater,UserBotPatch} from '../../../../../packages/core/src/im/user-bot-update.js'
import {UserBotUpdateError} from '../../../../../packages/core/src/im/user-bot-update.js'
import {registerUserBotUpdateRoute} from '../../../src/modules/im/routes.js'
test('Bot PUT HTTP协议保持Python bool/null/整数路径，拒绝数组和错误DTO并忽略owner伪造',async()=>{
 const app=Fastify(),calls:{owner:string;id:number;input:UserBotPatch}[]=[]
 const update=(async(owner:string,id:number,input:UserBotPatch)=>{calls.push({owner,id,input});if(input.group_response_mode==='invalid')throw new UserBotUpdateError('无效的群聊回应方式');return {name:'updated'}}) as unknown as ReturnType<typeof createUserBotUpdater>
 registerUserBotUpdateRoute(app,{requireUser:async(req,reply)=>{if(req.headers.authorization!=='user')return reply.code(401).send({detail:'未登录'})},ownerIdFromRequest:()=> 'verified-owner',update})
 const call=(payload:unknown,id='7',auth='user')=>app.inject({method:'PUT',url:`/api/v1/me/bots/${id}`,headers:{authorization:auth},payload:payload as any})
 try{
  assert.equal((await call({},'7','')).statusCode,401);assert.equal(calls.length,0)
  assert.equal((await call({enabled:'YES',group_read_enabled:0,name:null,user_id:'forged-owner'},'7.0')).statusCode,200);assert.deepEqual(calls[0],{owner:'verified-owner',id:7,input:{enabled:true,group_read_enabled:false,name:null}})
  assert.equal((await call({private_streaming_enabled:false})).statusCode,200);assert.deepEqual(calls.at(-1),{owner:'verified-owner',id:7,input:{private_streaming_enabled:false}})
  const before=calls.length;for(const payload of [{enabled:['true']},{name:12},{group_allowed_tools:['web_search',12]},null,[]])assert.equal((await call(payload)).statusCode,422);assert.equal(calls.length,before)
  assert.equal((await call({},'7e0')).statusCode,422);assert.equal((await call({group_response_mode:'invalid'})).statusCode,400)
 }finally{await app.close()}
})
