import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'

test('Node Host 对文件 PATCH 执行认证并传递字段存在性与撤销上下文',async()=>{
  const userId='00000000-0000-4000-8000-000000000061',secret='synthetic-file-update-host-secret',calls:unknown[][]=[]
  const app=createApp({appName:'合成测试应用',isReady:async()=>true,userAuth:{secret,async lookupUser(id){
    return id===userId?{id,username:'sample',displayName:'示例用户',email:'sample@example.invalid',avatarUrl:null,
      createdAt:null,timezone:null,emailSubscribed:false,imChannels:[],isActive:true,securityVersion:1}:null
  }},fileUpdates:{async update(...args){calls.push(args);return {id:5,version:2}}},
  })
  try{
    const denied=await app.inject({method:'PATCH',url:'/api/v1/files/5',payload:{version:1,displayName:'新名称',projectId:null}})
    assert.equal(denied.statusCode,401)
    const response=await app.inject({method:'PATCH',url:'/api/v1/files/5',headers:{authorization:`Bearer ${createUserToken(userId,1,secret)}`,'x-undo-context-id':'files-tab'},
      payload:{version:1,displayName:'新名称',projectId:null}})
    assert.equal(response.statusCode,200)
    assert.equal(calls.length,1);assert.equal(calls[0]![0],userId)
    assert.equal(calls[0]![1],5)
    const input=calls[0]![2] as {version:number;displayName:string;folderSet:boolean;projectSet:boolean;projectId:null;workspaceDirectorySet:boolean}
    assert.equal(input.version,1);assert.equal(input.displayName,'新名称');assert.equal(input.projectId,null)
    assert.equal(input.folderSet,false);assert.equal(input.projectSet,true);assert.equal(input.workspaceDirectorySet,false)
    assert.equal((calls[0]![3] as {undoContextId:string}).undoContextId,'files-tab')
  }finally{await app.close()}
})
