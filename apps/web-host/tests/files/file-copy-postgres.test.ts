import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresFileCopyOperations } from '../../src/domains/files/file-copy-postgres.js'

const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner='11111111-1111-4111-8111-111111111111'
const other='22222222-2222-4222-8222-222222222222'
test('PostgreSQL Local 复制创建重名副本，覆盖更新正文/版本/配额并隔离 owner',{
  skip:!databaseUrl&&'设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 文件复制回归',
},async()=>{
  const schema=`gugu_file_copy_${randomUUID().replaceAll('-','')}`
  const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:2})
  const root=await mkdtemp(path.join(tmpdir(),'gugu-file-copy-'));const events:Array<[number,string]>=[]
  try{
    await pool.query(`
      CREATE TABLE projects(id serial PRIMARY KEY,user_id uuid,name text,color text,start_date date,created_at timestamptz DEFAULT CURRENT_TIMESTAMP,deleted_at timestamptz);
      CREATE TABLE workspace_directories(id serial PRIMARY KEY,user_id uuid,directory_name text,deleted_at timestamptz);
      CREATE TABLE folders(id serial PRIMARY KEY,user_id uuid,project_id int,workspace_directory_id int,parent_id int,name text,deleted_at timestamptz);
      CREATE TABLE files(id serial PRIMARY KEY,user_id uuid,display_name text,ext text,space text,project_id int,folder_id int,workspace_directory_id int,
        stage_name text,mind_map_id int,storage_key text,storage_backend text,version int,size text,size_bytes bigint,mime_type text,img_width int,img_height int,
        created_at timestamptz,updated_at timestamptz,deleted_at timestamptz);
      CREATE TABLE storage_quota_ledgers(user_id uuid,category text,used_bytes bigint,reserved_bytes bigint,limit_bytes bigint,status text,updated_at timestamptz,PRIMARY KEY(user_id,category));
      CREATE TABLE storage_quota_events(user_id uuid,category text,operation text,delta_bytes bigint,resource_type text,resource_id text,idempotency_key text,metadata_json jsonb,created_at timestamptz);
      CREATE TABLE undo_operations(id text PRIMARY KEY,user_id uuid,undo_context_id text,group_id text,resource text,action text,target_refs jsonb,before_state jsonb,
        after_state jsonb,base_versions jsonb,artifact_refs jsonb,actor_type text,status text,created_at timestamptz,expires_at timestamptz);
      INSERT INTO files(user_id,display_name,ext,space,stage_name,storage_key,storage_backend,version,size,size_bytes,mime_type,created_at,updated_at)
      VALUES('${owner}','doc','txt','personal','','${owner}/个人文件/doc.txt','local',1,'4 B',4,'text/plain',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('${owner}','doc','txt','personal','','${owner}/个人文件/target/doc.txt','local',1,'3 B',3,'text/plain',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('${other}','private','txt','personal','','${other}/个人文件/private.txt','local',1,'3 B',3,'text/plain',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO storage_quota_ledgers(user_id,category,used_bytes,reserved_bytes,limit_bytes,status)
      VALUES('${owner}','file_library',7,0,1000,'active');
    `)
    const source=path.join(root,owner,'个人文件','doc.txt');await mkdir(path.dirname(source),{recursive:true});await writeFile(source,'body')
    const target=path.join(root,owner,'个人文件','target','doc.txt');await mkdir(path.dirname(target),{recursive:true});await writeFile(target,'old')
    const foreign=path.join(root,other,'个人文件','private.txt');await mkdir(path.dirname(foreign),{recursive:true});await writeFile(foreign,'nope')
    const ops=createPostgresFileCopyOperations(pool,{storageRoot:root,fileSyncEnabled:false,async publishChanged(e){events.push([e.entityId,e.operation])}})
    const copy=await ops.copy(owner,1,{folderId:null,projectId:null,workspaceDirectoryId:null,onConflict:'keep_both',overwriteFileId:null},{idempotencyKey:null,undoContextId:'copy-tab',clientId:'renderer'}) as {id:number;displayName:string;version:number}
    assert.notEqual(copy.id,1);assert.equal(copy.displayName,'doc(1)');assert.equal(copy.version,1)
    assert.equal(await readFile(path.join(root,owner,'个人文件','doc(1).txt'),'utf8'),'body')
    const replaced=await ops.copy(owner,1,{folderId:null,projectId:null,workspaceDirectoryId:null,onConflict:'overwrite',overwriteFileId:2},{idempotencyKey:null,undoContextId:null,clientId:'renderer'}) as {id:number;version:number;sizeBytes:number}
    assert.equal(replaced.id,2);assert.equal(replaced.version,2);assert.equal(replaced.sizeBytes,4);assert.equal(await readFile(target,'utf8'),'body')
    const ledger=await pool.query<{used_bytes:number}>('SELECT used_bytes FROM storage_quota_ledgers WHERE user_id=$1',[owner]);assert.equal(Number(ledger.rows[0]!.used_bytes),12)
    await assert.rejects(ops.copy(other,1,{folderId:null,projectId:null,workspaceDirectoryId:null,onConflict:'keep_both',overwriteFileId:null},{idempotencyKey:null,undoContextId:null,clientId:null}),/文件不存在/)
    assert.equal(await readFile(foreign,'utf8'),'nope');assert.deepEqual(events,[[4,'create'],[2,'create']])
    await ops.copy(owner,1,{folderId:null,projectId:null,workspaceDirectoryId:null,onConflict:'overwrite',overwriteFileId:1},{idempotencyKey:null,undoContextId:'self-copy-tab',clientId:'renderer'})
    assert.deepEqual(events,[[4,'create'],[2,'create'],[1,'create']])
    const receipt=await pool.query<{action:string;undo_context_id:string}>('SELECT action,undo_context_id FROM undo_operations WHERE undo_context_id=$1',['self-copy-tab'])
    assert.deepEqual(receipt.rows,[{action:'create',undo_context_id:'self-copy-tab'}])
    const quotaEvents=await pool.query<{operation:string;idempotency_key:string}>('SELECT operation,idempotency_key FROM storage_quota_events ORDER BY idempotency_key')
    assert.deepEqual(quotaEvents.rows.map(row=>row.operation).sort(),['file_copy','file_copy_overwrite'])
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
