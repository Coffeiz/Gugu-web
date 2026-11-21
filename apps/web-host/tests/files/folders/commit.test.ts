import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Pool} from 'pg'
import test from 'node:test'
import {createPostgresFolderWriteOperations} from '../../../src/modules/files/folders/write.js'
import {createLocalPathMirrorMutation} from '../../../src/modules/files/storage/paths.js'
const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL,owner='11111111-1111-4111-8111-111111111111'
test('文件夹事务 COMMIT 成功但响应丢失时保留数据库引用路径',{skip:!url&&'需要隔离 PostgreSQL'},async()=>{
 const schema=`folder_commit_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`}),root=await mkdtemp(path.join(tmpdir(),'folder-commit-'))
 const beforeKey=`${owner}/scope/old.txt`,afterKey=`${owner}/scope/new.txt`,before=path.join(root,...beforeKey.split('/')),after=path.join(root,...afterKey.split('/'))
 try{
  await pool.query(`CREATE TABLE folders(id serial PRIMARY KEY,user_id uuid,project_id int,workspace_directory_id int,parent_id int,name text,search_romaji text,version int,deleted_at timestamptz,created_at timestamptz,updated_at timestamptz);CREATE TABLE files(id int,user_id uuid,folder_id int,deleted_at timestamptz,storage_key text)`)
  await pool.query('INSERT INTO files VALUES(1,$1,NULL,NULL,$2)',[owner,beforeKey])
  await mkdir(path.dirname(before),{recursive:true});await writeFile(before,'原正文')
  const wrapped={async connect(){const client=await pool.connect(),query=client.query.bind(client);client.query=(async (...args:Parameters<typeof client.query>)=>{const result=await (query as (...args:any[])=>Promise<any>)(...args);if(args[0]==='COMMIT')throw new Error('模拟提交后断连');return result}) as typeof client.query;return client}} as unknown as Pool
  const ops=createPostgresFolderWriteOperations(wrapped,{buildSearchRomaji:()=>'',async capturePathMirrorDirectoryKeys(){return []},async preparePathMirrorMutation(client){await client.query('UPDATE files SET storage_key=$1 WHERE id=1',[afterKey]);return createLocalPathMirrorMutation(root,owner,[{fromKey:beforeKey,toKey:afterKey,preserveSourceUntilFinalize:true}],[`${owner}/scope`],[])},async recordForwardUndo(){},async publishChanged(){},onPathCleanupFailure(){},onPathRollbackFailure(){}})
  await assert.rejects(ops.create(owner,{name:'合成目录',projectId:null,workspaceDirectoryId:null,parentId:null},{undoContextId:null,origin:null}),/模拟提交后断连/)
  assert.equal((await pool.query('SELECT id FROM folders')).rowCount,1)
  assert.equal((await pool.query('SELECT storage_key FROM files WHERE id=1')).rows[0].storage_key,afterKey)
  assert.equal(await readFile(after,'utf8'),'原正文')
  assert.equal(await readFile(before,'utf8'),'原正文')
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
