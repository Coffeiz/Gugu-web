import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import test from 'node:test'
import {createPostgresFileBrowserOperations} from '../../src/domains/files/file-browser-postgres.js'
import {createPostgresFileReadOperations} from '../../src/domains/files/file-reads-postgres.js'
const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL,owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
test('损坏的跨用户关联不会泄漏项目和文件夹名称',{skip:!url&&'需要隔离 PostgreSQL'},async()=>{
 const schema=`gugu_foreign_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`})
 try{
  await pool.query(`CREATE COLLATION gugu_natural_zh (provider=icu,locale='zh-u-kn-true');CREATE TABLE projects(id int,user_id uuid,name text,color text);CREATE TABLE folders(id int,user_id uuid,name text);CREATE TABLE files(id int,user_id uuid,display_name text,ext text,space text,workspace_directory_id int,project_id int,stage_name text,folder_id int,mind_map_id int,size text,size_bytes bigint,mime_type text,created_at timestamptz,deleted_at timestamptz,img_width int,img_height int,version int,storage_key text);
   INSERT INTO projects VALUES(7,'${other}','私有项目','#123456');INSERT INTO folders VALUES(8,'${other}','私有目录');INSERT INTO files VALUES(1,'${owner}','样例','TXT','project',NULL,7,'',8,NULL,'1 B',1,'text/plain',now(),NULL,NULL,NULL,1,'${owner}/x.txt')`)
  const list=await createPostgresFileBrowserOperations(pool,'synthetic-secret').listFiles(owner,{limit:10,cursor:null,sortBy:'id',sortOrder:'asc',space:'project',projectId:7,folderId:8,workspaceDirectoryId:null,mindMapId:null,ext:null,q:null}) as {items:Array<{projectName:string|null;folderName:string|null}>}
  const detail=await createPostgresFileReadOperations(pool).getFile(owner,1) as {projectName:string|null;folderName:string|null}
  assert.equal(detail.projectName,null);assert.equal(detail.folderName,null);assert.equal(list.items[0]?.projectName,null);assert.equal(list.items[0]?.folderName,null)
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})
