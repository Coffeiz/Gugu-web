import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {createPostgresRuntime} from '@gugu/core/data'
import {openLocalFile,UnsafeLocalPathError} from '@gugu/fs/node'
import Fastify from 'fastify'
import {createAttachmentDownloader} from '@gugu/core/agent/attachments/download'
import {registerAttachmentDownloadRoute} from '../../src/modules/agent/attachments/download.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'

const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('附件下载DB优先和owner隔离，legacy可读，物理缺失及不安全路径拒绝，脏size不截断', {skip:!databaseUrl&&'需要隔离PostgreSQL'},async()=>{
 const owner='00000000-0000-4000-8000-000000000101',foreign='00000000-0000-4000-8000-000000000102',schema=`attachment_download_${randomUUID().replaceAll('-','')}`
 const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:1}),runtime=await createPostgresRuntime({url:databaseUrl!,schema}),root=await mkdtemp(join(tmpdir(),'gugu-attachment-download-'))
 let legacyReads=0
 const app=Fastify();installHttpErrorHandler(app)
 try{
  await pool.query('CREATE TABLE chat_attachments(user_id uuid,attach_id text,name text,ext text,mime text,size bigint,storage_key text,extra json)')
  await mkdir(join(root,owner));await writeFile(join(root,owner,'sample.txt'),'合成下载')
  await writeFile(join(root,'outside.txt'),'外部文件');await symlink(join(root,'outside.txt'),join(root,owner,'symlink.txt'))
  await pool.query("INSERT INTO chat_attachments VALUES($1,'owned','合成 文件','txt','text/plain',12,$3,NULL),($2,'foreign','其他文件','txt','text/plain',12,$3,NULL),($1,'dirty','脏长度','txt','text/plain',1,$3,NULL),($1,'missing','缺失','txt','text/plain',1,$4,NULL),($1,'escape','越界','txt','text/plain',1,'../outside.txt',NULL),($1,'symlink','链接','txt','text/plain',1,$5,NULL)",[owner,foreign,`${owner}/sample.txt`,`${owner}/missing.txt`,`${owner}/symlink.txt`])
  const download=createAttachmentDownloader(runtime.db,{readLegacy:async(id,attachId)=>{assert.equal(id,owner);legacyReads++;if(attachId==='redis-failure')throw new Error('synthetic-private-redis');return attachId==='legacy'?JSON.stringify({name:'旧附件',ext:'txt',mime:'text/plain',size:12,storage_key:`${owner}/sample.txt`}):null},open:key=>openLocalFile(root,key),isUnsafe:error=>error instanceof UnsafeLocalPathError})
  registerAttachmentDownloadRoute(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='user')return reply.code(401).send({detail:'未授权'})},ownerIdFromRequest:()=>owner,download})
  assert.equal((await app.inject('/api/v1/agent/attachment/owned/download')).statusCode,401);assert.equal(legacyReads,0)
  const request=(id:string)=>app.inject({url:`/api/v1/agent/attachment/${id}/download`,headers:{authorization:'user'}})
  const response=await request('owned')
  assert.equal(response.statusCode,200);assert.equal(response.body,'合成下载');assert.equal(response.headers['content-length'],'12')
  assert.equal(response.headers['content-disposition'],"attachment; filename*=UTF-8''%E5%90%88%E6%88%90%20%E6%96%87%E4%BB%B6.txt")
  assert.equal(response.headers['content-type'],'text/plain; charset=utf-8');assert.equal(response.headers['cache-control'],'private, max-age=300');assert.equal(legacyReads,0)
  assert.equal((await request('foreign')).statusCode,404)
  const legacy=await request('legacy');assert.equal(legacy.statusCode,200);assert.equal(legacy.body,'合成下载')
  for(const id of ['missing','escape','symlink'])assert.equal((await request(id)).statusCode,404,id)
  const dirty=await request('dirty');assert.equal(dirty.statusCode,200);assert.equal(dirty.body,'合成下载');assert.equal(dirty.headers['content-length'],'12')
  const redisFailure=await request('redis-failure');assert.equal(redisFailure.statusCode,500);assert.equal(redisFailure.body.includes('synthetic-private-redis'),false)
  const beforeFailure=legacyReads;await pool.query('DROP TABLE chat_attachments')
  const databaseFailure=await request('owned');assert.equal(databaseFailure.statusCode,500);assert.equal(legacyReads,beforeFailure)
 }finally{await app.close();await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
