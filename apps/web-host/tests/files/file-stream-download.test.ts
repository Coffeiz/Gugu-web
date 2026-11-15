import assert from 'node:assert/strict'
import {mkdtemp,open,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {createApp} from '../../src/app.js'
import {createUserToken} from '../../src/domains/auth/auth.js'

test('Cookie 流地址支持附件下载及 Range，普通预览保持 inline',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'gugu-stream-download-')),file=path.join(root,'data')
 await writeFile(file,'0123456789');const owner='11111111-1111-4111-8111-111111111111',secret='synthetic-secret-for-stream'
 const app=createApp({appName:'合成应用',isReady:async()=>true,userAuth:{secret,async lookupUser(id){return id===owner?{id,username:'sample',displayName:null,email:'sample@example.invalid',avatarUrl:null,createdAt:null,timezone:null,emailSubscribed:false,imChannels:[],isActive:true,securityVersion:1}:null}},fileReads:{async getFile(){return {id:1}},async openContent(){return {file:{},handle:await open(file,'r'),size:10,fileName:'报告.txt',mimeType:'text/plain'}}} as any})
 const cookie=`gugu_user_access_token=${createUserToken(owner,1,secret)}`
 try {
  const normal=await app.inject({url:'/api/v1/files/1/stream',headers:{cookie}});assert.equal(normal.headers['content-disposition'],'inline')
  const result=await app.inject({url:'/api/v1/files/1/stream?dl=1',headers:{cookie,range:'bytes=2-4'}})
  assert.equal(result.statusCode,206);assert.equal(result.body,'234');assert.match(String(result.headers['content-disposition']),/^attachment; filename\*=UTF-8''/)
  const zero=await app.inject({url:'/api/v1/files/1/stream?dl=0',headers:{cookie}});assert.equal(zero.headers['content-disposition'],'inline')
  const invalid=await app.inject({url:'/api/v1/files/1/stream?dl=bad',headers:{cookie}});assert.equal(invalid.statusCode,422)
  const denied=await app.inject({url:'/api/v1/files/1/stream?dl=1'});assert.equal(denied.statusCode,401)
 }finally{await app.close();await rm(root,{recursive:true,force:true})}
})
