import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import test from 'node:test'
import {createPostgresFileReadOperations} from '../../../src/modules/files/browse.js'
const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL,owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
test('无旧文件夹表时，损坏的跨用户关联不会泄漏项目名称',{skip:!url&&'需要隔离 PostgreSQL'},async()=>{
 const schema=`gugu_foreign_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`})
 try{
  await pool.query(`CREATE TABLE projects(id int,user_id uuid,name text,color text);CREATE TABLE files(user_id uuid,display_name text,ext text,space text,workspace_directory_id int,project_id int,stage_name text,mind_map_id int,size text,size_bytes bigint,mime_type text,created_at timestamptz,deleted_at timestamptz,img_width int,img_height int,version int,path text,PRIMARY KEY(user_id,path));
   INSERT INTO projects VALUES(7,'${other}','私有项目','#123456');INSERT INTO files VALUES('${owner}','样例','TXT','project',NULL,7,'',NULL,'1 B',1,'text/plain',now(),NULL,NULL,NULL,1,'${owner}/x.txt')`)
  const detail=await createPostgresFileReadOperations(pool).getFile(owner,`${owner}/x.txt`) as {projectName:string|null}
  assert.equal(detail.projectName,null)
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})
