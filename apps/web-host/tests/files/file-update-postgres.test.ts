import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresFileUpdateOperations } from '../../src/domains/files/file-update-postgres.js'

const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner='11111111-1111-4111-8111-111111111111'
const other='22222222-2222-4222-8222-222222222222'

test('PostgreSQL Local PATCH 保留省略字段、搬迁文件、写撤销记录并拒绝陈旧版本和越权',{
  skip:!databaseUrl&&'设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 文件元数据回归',
},async()=>{
  const schema=`gugu_file_update_${randomUUID().replaceAll('-','')}`
  const admin=new Pool({connectionString:databaseUrl,max:1}); await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:2})
  const root=await mkdtemp(path.join(tmpdir(),'gugu-file-update-')); const events:number[]=[]
  try{
    await pool.query(`
      CREATE TABLE projects(id serial PRIMARY KEY,user_id uuid NOT NULL,name text NOT NULL,color text,start_date date,created_at timestamptz DEFAULT CURRENT_TIMESTAMP,deleted_at timestamptz);
      CREATE TABLE workspace_directories(id serial PRIMARY KEY,user_id uuid NOT NULL,directory_name text NOT NULL,deleted_at timestamptz);
      CREATE TABLE folders(id serial PRIMARY KEY,user_id uuid NOT NULL,project_id int,workspace_directory_id int,parent_id int,name text NOT NULL,deleted_at timestamptz);
      CREATE TABLE files(id serial PRIMARY KEY,user_id uuid NOT NULL,display_name text NOT NULL,ext text NOT NULL,space text NOT NULL,
        project_id int,folder_id int,workspace_directory_id int,stage_name text NOT NULL,mind_map_id int,storage_key text NOT NULL,
        version int NOT NULL,size text NOT NULL,size_bytes bigint NOT NULL,mime_type text,img_width int,img_height int,
        created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,deleted_at timestamptz);
      CREATE TABLE undo_operations(id text PRIMARY KEY,user_id uuid NOT NULL,undo_context_id text,group_id text,resource text,action text,
        target_refs jsonb,before_state jsonb,after_state jsonb,base_versions jsonb,artifact_refs jsonb,actor_type text,status text,
        created_at timestamptz,expires_at timestamptz,undone_at timestamptz,failure_code text);
      INSERT INTO projects(user_id,name,color,start_date) VALUES('${owner}','项目甲','#abc','2026-02-01');
      INSERT INTO files(user_id,display_name,ext,space,stage_name,storage_key,version,size,size_bytes,mime_type,created_at,updated_at)
      VALUES('${owner}','笔记','md','personal','','${owner}/个人文件/笔记.md',1,'4 B',4,'text/markdown',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
            ('${other}','私有','md','personal','','${other}/个人文件/私有.md',1,'3 B',3,'text/markdown',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    `)
    const source=path.join(root,owner,'个人文件','笔记.md'); await mkdir(path.dirname(source),{recursive:true}); await writeFile(source,'正文')
    const foreign=path.join(root,other,'个人文件','私有.md'); await mkdir(path.dirname(foreign),{recursive:true}); await writeFile(foreign,'私有')
    const operations=createPostgresFileUpdateOperations(pool,{storageRoot:root,async publishChanged(e){events.push(e.entityId)}})
    const renamed=await operations.update(owner,1,{version:1,displayName:'新笔记',folderSet:false,projectSet:false,workspaceDirectorySet:false},
      {idempotencyKey:null,undoContextId:'editor',clientId:'test'}) as {displayName:string;version:number;projectId:number|null}
    const renamedPath=path.join(root,owner,'个人文件','新笔记.md')
    assert.equal(renamed.displayName,'新笔记'); assert.equal(renamed.version,2); assert.equal(renamed.projectId,null)
    assert.equal(await readFile(renamedPath,'utf8'),'正文'); await assert.rejects(readFile(source),{code:'ENOENT'})
    const moved=await operations.update(owner,1,{version:2,projectId:1,projectSet:true,folderSet:false,workspaceDirectorySet:false},
      {idempotencyKey:null,undoContextId:null,clientId:'test'}) as {space:string;projectId:number;version:number}
    const movedPath=path.join(root,owner,'项目文件','2026','02','项目甲 #1','新笔记.md')
    assert.equal(moved.space,'project'); assert.equal(moved.projectId,1); assert.equal(moved.version,3)
    assert.equal(await readFile(movedPath,'utf8'),'正文'); await assert.rejects(readFile(renamedPath),{code:'ENOENT'})
    await assert.rejects(operations.update(owner,1,{version:2,displayName:'旧版本',folderSet:false,projectSet:false,workspaceDirectorySet:false},
      {idempotencyKey:null,undoContextId:null,clientId:null}),/其他端修改/)
    await assert.rejects(operations.update(other,1,{version:3,displayName:'越权',folderSet:false,projectSet:false,workspaceDirectorySet:false},
      {idempotencyKey:null,undoContextId:null,clientId:null}),/文件不存在/)
    const undo=await pool.query<{before_state:Record<string,any>}>('SELECT before_state FROM undo_operations WHERE user_id=$1',[owner])
    assert.equal(undo.rows.length,1); assert.equal(undo.rows[0]!.before_state.items['file:1'].storage_key,`${owner}/个人文件/笔记.md`)
    assert.deepEqual(events,[1,1])
    assert.equal(await readFile(foreign,'utf8'),'私有')
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
