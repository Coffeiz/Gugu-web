import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../../src/app.js'
import { createUserToken } from '../../../src/modules/auth/session/token.js'

test('Node Host 文件复制路由认证 owner 并传递目标、冲突模式和请求元数据',async()=>{
  const user='00000000-0000-4000-8000-000000000061',secret='synthetic-file-copy-host-secret',calls:unknown[][]=[]
  const app=createApp({appName:'合成测试应用',isReady:async()=>true,userAuth:{secret,async lookupUser(id){return id===user?{
    id,username:'sample',displayName:'示例用户',email:'sample@example.invalid',avatarUrl:null,createdAt:null,timezone:null,
    emailSubscribed:false,imChannels:[],isActive:true,securityVersion:1,
  }:null}},fileCopies:{async copy(...args){calls.push(args);return {id:8,displayName:'doc(1)',version:1}}}})
  try{
    const denied=await app.inject({method:'POST',url:'/api/v1/files/by-path/copy?path=owner%2Fpersonal%2Fnote.txt',payload:{folderPath:null,projectId:null}})
    assert.equal(denied.statusCode,401)
    const invalid=await app.inject({method:'POST',url:'/api/v1/files/by-path/copy?path=owner%2Fpersonal%2Fnote.txt',headers:{authorization:`Bearer ${createUserToken(user,1,secret)}`,'content-type':'application/json'},payload:'[]'})
    assert.equal(invalid.statusCode,422)
    const response=await app.inject({method:'POST',url:'/api/v1/files/by-path/copy?path=owner%2Fpersonal%2Fnote.txt',headers:{authorization:`Bearer ${createUserToken(user,1,secret)}`,'x-client-id':'renderer'},
      payload:{folderPath:null,projectId:null,workspaceDirectoryId:null,onConflict:'overwrite',overwriteFilePath:'owner/personal/target.txt'}})
    assert.equal(response.statusCode,200);assert.equal(response.json().displayName,'doc(1)')
    assert.equal(calls.length,1);assert.equal(calls[0]![0],user);assert.equal(calls[0]![1],'owner/personal/note.txt')
    assert.deepEqual(calls[0]![2],{folderPath:null,projectId:null,workspaceDirectoryId:null,onConflict:'overwrite',overwriteFilePath:'owner/personal/target.txt'})
    assert.equal((calls[0]![3] as {clientId:string}).clientId,'renderer')
  }finally{await app.close()}
})
