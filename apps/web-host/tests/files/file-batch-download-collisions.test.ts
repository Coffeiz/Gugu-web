import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import {Pool} from 'pg'
import test from 'node:test'
import {createApp} from '../../src/app.js'
import {createUserToken} from '../../src/modules/auth/auth.js'
import {createPostgresFileBatchDownloadOperations} from '../../src/modules/files/file-batch-download-postgres.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner='11111111-1111-4111-8111-111111111111',secret='synthetic-download-secret'
test('批量下载重名与后缀冲突保留全部正文',{skip:!databaseUrl&&'需要隔离 PostgreSQL'},async()=>{
 const schema=`zip_collision_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`}),root=await mkdtemp(path.join(tmpdir(),'zip-collision-'))
 const app=createApp({appName:'合成测试',isReady:async()=>true,userAuth:{secret,async lookupUser(id){return id===owner?{id,username:'sample',displayName:null,email:'sample@example.invalid',avatarUrl:null,createdAt:null,timezone:null,emailSubscribed:false,imChannels:[],isActive:true,securityVersion:1}:null}},fileBatchDownloads:createPostgresFileBatchDownloadOperations(pool,root)})
 try{
  await pool.query(`CREATE TABLE files(id int,user_id uuid,display_name text,ext text,storage_key text,mime_type text,folder_id int,deleted_at timestamptz);CREATE TABLE folders(id int,user_id uuid,parent_id int,name text,deleted_at timestamptz)`)
  for(const [id,name,body] of [[1,'a','first'],[2,'a_1','second'],[3,'a','third']] as const){const key=`${owner}/test/${id}.txt`,disk=path.join(root,key);await mkdir(path.dirname(disk),{recursive:true});await writeFile(disk,body);await pool.query('INSERT INTO files VALUES($1,$2,$3,$4,$5,$6,NULL,NULL)',[id,owner,name,'TXT',key,'text/plain'])}
  const response=await app.inject({method:'POST',url:'/api/v1/files/batch-download',headers:{authorization:`Bearer ${createUserToken(owner,1,secret)}`},payload:{ids:[1,2,3]}})
  assert.equal(response.statusCode,200);const zip=await JSZip.loadAsync(response.rawPayload);const files=Object.values(zip.files).filter(f=>!f.dir)
  assert.equal(files.length,3);assert.deepEqual((await Promise.all(files.map(f=>f.async('string')))).sort(),['first','second','third'])
 }finally{await app.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
