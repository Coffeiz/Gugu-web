import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresFileCopyOperations } from '../../../src/modules/files/store.js'

const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner='11111111-1111-4111-8111-111111111111'
const other='22222222-2222-4222-8222-222222222222'
test('PostgreSQL Local 复制创建重名副本，覆盖更新正文与版本并隔离 owner',{
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
      CREATE TABLE files(id serial PRIMARY KEY,user_id uuid,display_name text,ext text,space text,project_id int,workspace_directory_id int,
        stage_name text,mind_map_id int,path text,storage_backend text,version int,size text,size_bytes bigint,mime_type text,img_width int,img_height int,
        created_at timestamptz,updated_at timestamptz,deleted_at timestamptz);
      CREATE TABLE undo_operations(id text PRIMARY KEY,user_id uuid,undo_context_id text,group_id text,resource text,action text,target_refs jsonb,before_state jsonb,
        after_state jsonb,base_versions jsonb,artifact_refs jsonb,actor_type text,status text,created_at timestamptz,expires_at timestamptz);
      INSERT INTO files(user_id,display_name,ext,space,stage_name,path,storage_backend,version,size,size_bytes,mime_type,created_at,updated_at)
      VALUES('${owner}','doc','txt','personal','','${owner}/个人文件/doc.txt','local',1,'4 B',4,'text/plain',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('${owner}','doc','txt','personal','','${owner}/个人文件/target/doc.txt','local',1,'3 B',3,'text/plain',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('${other}','private','txt','personal','','${other}/个人文件/private.txt','local',1,'3 B',3,'text/plain',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    `)
    const source=path.join(root,owner,'个人文件','doc.txt');await mkdir(path.dirname(source),{recursive:true});await writeFile(source,'body')
    const target=path.join(root,owner,'个人文件','target','doc.txt');await mkdir(path.dirname(target),{recursive:true});await writeFile(target,'old')
    const foreign=path.join(root,other,'个人文件','private.txt');await mkdir(path.dirname(foreign),{recursive:true});await writeFile(foreign,'nope')
    const ops=createPostgresFileCopyOperations(pool,{storageRoot:root,fileSyncEnabled:false,removeCommittedBackup(){throw new Error('模拟同步清理失败')},async publishChanged(e){events.push([e.entityId,e.operation])}})
    const copy=await ops.copy(owner,1,{folderPath:null,projectId:null,workspaceDirectoryId:null,onConflict:'keep_both',overwriteFileId:null},{idempotencyKey:null,undoContextId:'copy-tab',clientId:'renderer'}) as {id:number;displayName:string;version:number}
    assert.notEqual(copy.id,1);assert.equal(copy.displayName,'doc(1)');assert.equal(copy.version,1)
    assert.equal(await readFile(path.join(root,owner,'个人文件','doc(1).txt'),'utf8'),'body')
    const replaced=await ops.copy(owner,1,{folderPath:'target',projectId:null,workspaceDirectoryId:null,onConflict:'overwrite',overwriteFileId:2},{idempotencyKey:null,undoContextId:null,clientId:'renderer'}) as {id:number;version:number;sizeBytes:number}
    assert.equal(replaced.id,2);assert.equal(replaced.version,2);assert.equal(replaced.sizeBytes,4);assert.equal(await readFile(target,'utf8'),'body')
    await assert.rejects(ops.copy(other,1,{folderPath:null,projectId:null,workspaceDirectoryId:null,onConflict:'keep_both',overwriteFileId:null},{idempotencyKey:null,undoContextId:null,clientId:null}),/文件不存在/)
    assert.equal(await readFile(foreign,'utf8'),'nope');assert.deepEqual(events,[[4,'create'],[2,'create']])
    await ops.copy(owner,1,{folderPath:null,projectId:null,workspaceDirectoryId:null,onConflict:'overwrite',overwriteFileId:1},{idempotencyKey:null,undoContextId:'self-copy-tab',clientId:'renderer'})
    assert.deepEqual(events,[[4,'create'],[2,'create'],[1,'create']])
    const receipt=await pool.query<{action:string;undo_context_id:string}>('SELECT action,undo_context_id FROM undo_operations WHERE undo_context_id=$1',['self-copy-tab'])
    assert.deepEqual(receipt.rows,[{action:'create',undo_context_id:'self-copy-tab'}])
    const unknownPool={async connect(){const client=await pool.connect();const rawQuery=client.query;const query=rawQuery.bind(client);const release=client.release.bind(client)
      client.query=(async (...args:Parameters<typeof client.query>)=>{const result=await (query as (...args:any[])=>Promise<any>)(...args);if(args[0]==='COMMIT')throw new Error('模拟提交后断连');return result}) as typeof client.query
      client.release=(() => {client.query=rawQuery;release()}) as typeof client.release
      return client}} as unknown as Pool
    const unknownOps=createPostgresFileCopyOperations(unknownPool,{storageRoot:root,fileSyncEnabled:false,async publishChanged(){}})
    await writeFile(source,'new!')
    await assert.rejects(unknownOps.copy(owner,1,{folderPath:'target',projectId:null,workspaceDirectoryId:null,onConflict:'overwrite',overwriteFileId:2},{idempotencyKey:null,undoContextId:null,clientId:null}),/模拟提交后断连/)
    assert.equal(await readFile(target,'utf8'),'new!')
    const stage=(await readdir(path.dirname(target))).find(name=>name.startsWith('.copy-stage-'))!
    assert.equal(await readFile(path.join(path.dirname(target),stage,'content.old'),'utf8'),'body')
    const existingStages=new Set(await readdir(path.dirname(target)))
    const failedRollbackOps=createPostgresFileCopyOperations(pool,{storageRoot:root,fileSyncEnabled:false,async publishChanged(){},
      async recordFileChange(){throw new Error('模拟写入失败')},restoreBackup(){throw new Error('模拟同步回滚失败')}})
    await assert.rejects(failedRollbackOps.copy(owner,1,{folderPath:'target',projectId:null,workspaceDirectoryId:null,onConflict:'overwrite',overwriteFileId:2},{idempotencyKey:null,undoContextId:null,clientId:null}),/模拟写入失败/)
    const retained=(await readdir(path.dirname(target))).find(name=>name.startsWith('.copy-stage-')&&!existingStages.has(name))!
    assert.equal(await readFile(path.join(path.dirname(target),retained,'content.old'),'utf8'),'new!')
    await pool.query('UPDATE files SET path=$2 WHERE id=$1',[1,`${other}/个人文件/private.txt`])
    await assert.rejects(ops.copy(owner,1,{folderPath:null,projectId:null,workspaceDirectoryId:null,onConflict:'keep_both',overwriteFileId:null},{idempotencyKey:null,undoContextId:null,clientId:null}),/文件不存在/)
    assert.equal(await readFile(foreign,'utf8'),'nope')
    await pool.query('UPDATE files SET path=$2 WHERE id=$1',[1,`${owner}/个人文件/doc.txt`])
    await pool.query('UPDATE files SET path=$2 WHERE id=$1',[2,`${other}/个人文件/private.txt`])
    await assert.rejects(ops.copy(owner,1,{folderPath:'target',projectId:null,workspaceDirectoryId:null,onConflict:'overwrite',overwriteFileId:2},{idempotencyKey:null,undoContextId:null,clientId:null}),/文件不存在/)
    assert.equal(await readFile(foreign,'utf8'),'nope')
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
