import { CoreError } from '@gugu/core'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import type { WriteRequestMetadata } from '../../app.js'
import { isPathWithin } from '../../adapters/path-safety.js'
import { updateFileStorageQuota } from './persistence/storage-quota.js'
import type { FileCopyInput, FileCopyOperations } from './file-copy.js'
import { createLocalPathMirrorMutation } from './local-path-mirror.js'
import { lockFileSyncPath, recordCanonicalFileChange } from './persistence/file-sync-canonical-change.js'
import { createHash } from 'node:crypto'

type Row=QueryResultRow & Record<string,any>
async function pathFor(rootPath:string,key:string):Promise<string>{
  const parts=key.split('/');if(parts.length<2||parts.some(p=>!p||p==='.'||p==='..'||p.includes('\\')||p.includes('\0')))throw new CoreError('not_found','文件不存在')
  const root=await realpath(rootPath);let target=root
  for(const part of parts){target=path.resolve(target,part);if(!isPathWithin(root,target))throw new CoreError('not_found','文件不存在');try{if((await lstat(target)).isSymbolicLink())throw new CoreError('not_found','文件不存在')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}}
  return target
}
async function folderNames(client:PoolClient,user:string,folderId:number,project:number|null,workspace:number|null):Promise<{names:string[];name:string}>{
  const q=await client.query<Row>(`WITH RECURSIVE chain AS(SELECT id,parent_id,name,project_id,workspace_directory_id,0 depth FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL UNION ALL SELECT f.id,f.parent_id,f.name,f.project_id,f.workspace_directory_id,c.depth+1 FROM folders f JOIN chain c ON c.parent_id=f.id WHERE f.user_id=$2 AND f.deleted_at IS NULL AND c.depth<64) SELECT * FROM chain ORDER BY depth DESC`,[folderId,user])
  if(!q.rows.length||q.rows[0].parent_id!==null)throw new CoreError('not_found','目标文件夹不存在，或不属于目标空间')
  const leaf=q.rows.at(-1)!;if(q.rows.some(r=>Number(r.project_id??0)!==Number(project??0)||Number(r.workspace_directory_id??0)!==Number(workspace??0)))throw new CoreError('not_found','目标文件夹不存在，或不属于目标空间')
  return {names:q.rows.map(r=>String(r.name).replace(/[\\/:*?"<>|]/g,'_')),name:leaf.name}
}
function response(row:Row,target:Row|null,folder:string|null){return {id:Number(row.id),displayName:row.display_name,ext:row.ext,space:row.space,workspaceDirectoryId:row.workspace_directory_id==null?null:Number(row.workspace_directory_id),projectId:row.project_id==null?null:Number(row.project_id),projectName:target?.name??null,projectColor:target?.color?.match(/#[0-9a-fA-F]{3,6}/)?.[0]??target?.color??null,stageName:row.stage_name,folderId:row.folder_id==null?null:Number(row.folder_id),folderName:folder,mindMapId:row.mind_map_id==null?null:Number(row.mind_map_id),size:row.size,sizeBytes:Number(row.size_bytes),mimeType:row.mime_type,createdAt:row.created_at instanceof Date?row.created_at.toISOString():String(row.created_at).replace(/Z?$/,'Z'),deletedAt:null,imgWidth:row.img_width==null?null:Number(row.img_width),imgHeight:row.img_height==null?null:Number(row.img_height),version:Number(row.version)}}

export function createPostgresFileCopyOperations(pool:Pool,options:{storageRoot:string;fileSyncEnabled:boolean;publishChanged(e:{ownerId:string;entityId:number;payload:Record<string,unknown>;origin:string|null;operation:'create'}):Promise<void>}):FileCopyOperations{
 return {async copy(rawOwner,fileId,input:FileCopyInput,metadata:WriteRequestMetadata){
  const user=/^[0-9a-f-]{36}$/i.test(rawOwner)?rawOwner.toLowerCase():'';if(!user)throw new CoreError('invalid_request','用户标识无效')
  const c=await pool.connect();let mutation:ReturnType<typeof createLocalPathMirrorMutation>|null=null,applied=false,committed=false,temp:string|null=null,finalPath:string|null=null,rollback:string|null=null
  try{
   await c.query('BEGIN');const srcQ=await c.query<Row>('SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE',[fileId,user]);const src=srcQ.rows[0];if(!src)throw new CoreError('not_found','文件不存在')
   const projectId=input.projectId,workspaceId=input.workspaceDirectoryId
   if(projectId!==null&&workspaceId!==null)throw new CoreError('invalid_request','项目与 Workspace 目录不能同时指定')
   let project:Row|null=null,workspaceName:string|null=null,space=workspaceId!==null?'workspace':projectId!==null?'project':'personal'
   if(projectId!==null){const q=await c.query<Row>(`SELECT id,name,color,COALESCE(to_char(start_date,'YYYY'),to_char(created_at,'YYYY')) year_value,COALESCE(to_char(start_date,'MM'),to_char(created_at,'MM')) month_value FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,[projectId,user]);project=q.rows[0]??null;if(!project)throw new CoreError('not_found','目标项目不存在')}
   if(workspaceId!==null){const q=await c.query<Row>('SELECT directory_name FROM workspace_directories WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',[workspaceId,user]);workspaceName=q.rows[0]?.directory_name??null;if(!workspaceName)throw new CoreError('not_found','Workspace 不存在')}
   const folder=input.folderId===null?null:await folderNames(c,user,input.folderId,projectId,workspaceId)
   const parent=space==='project'?[user,'项目文件',project!.year_value,project!.month_value,`${project!.name} #${projectId}`,...(folder?.names??[])]:space==='workspace'?[user,'workspace',workspaceName,...(folder?.names??[])]:[user,'个人文件',...(folder?.names??[])]
   const base=parent.map((x:any)=>String(x).replace(/[\\/:*?"<>|]/g,'_')).join('/')
   let targetId=input.overwriteFileId, display=src.display_name,key=''
   let target:Row|null=null
   if(input.onConflict==='overwrite'){
    const q=await c.query<Row>('SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE',[targetId,user]);target=q.rows[0]??null
    if(!target)throw new CoreError('not_found','要覆盖的文件不存在')
    if(Number(target.id)===fileId){
      if(metadata.undoContextId){const ref=`file:${target.id}`,snap={id:Number(target.id),display_name:target.display_name,ext:target.ext,space:target.space,project_id:target.project_id,folder_id:target.folder_id,workspace_directory_id:target.workspace_directory_id,stage_name:target.stage_name,storage_key:target.storage_key,version:Number(target.version),size:target.size,size_bytes:Number(target.size_bytes),mime_type:target.mime_type,img_width:target.img_width,img_height:target.img_height,deleted_at:null};await c.query(`INSERT INTO undo_operations(id,user_id,undo_context_id,group_id,resource,action,target_refs,before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at,expires_at) VALUES($1,$2,$3,$4,'files','create',$5::json,'{}'::json,$6::json,$7::json,'{}'::json,'web','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '30 days')`,[`op-${randomUUID().replaceAll('-','')}`,user,metadata.undoContextId.slice(0,128),`group-${randomUUID().replaceAll('-','')}`,JSON.stringify([{kind:'file',id:Number(target.id)}]),JSON.stringify({items:{[ref]:snap}}),JSON.stringify({[ref]:{version:0}})])}
      await c.query('COMMIT');committed=true;const result=response(target,project,folder?.name??null);await options.publishChanged({ownerId:user,entityId:Number(target.id),payload:result,origin:metadata.clientId,operation:'create'}).catch(()=>undefined);return result
    }
    if(target.space!==space||Number(target.project_id??0)!==Number(projectId??0)||Number(target.workspace_directory_id??0)!==Number(workspaceId??0)||Number(target.folder_id??0)!==Number(input.folderId??0)||target.display_name!==display||String(target.ext).toLowerCase()!==String(src.ext).toLowerCase())throw new CoreError('invalid_request','覆盖目标与复制文件不匹配')
    key=String(target.storage_key)
   }else{
    const ext=String(src.ext).toLowerCase();let n=0
    while(true){display=n?`${src.display_name}(${n})`:String(src.display_name);key=`${base}/${display}${ext?'.'+ext:''}`
     await lockFileSyncPath(c,user,key);const disk=await pathFor(options.storageRoot,key);const exists=await stat(disk).then(()=>true,(e:NodeJS.ErrnoException)=>e.code==='ENOENT'?false:Promise.reject(e));const collision=await c.query('SELECT 1 FROM files WHERE user_id=$1 AND storage_key=$2 AND deleted_at IS NULL',[user,key]);if(!exists&&!collision.rowCount)break;n++}
   }
   await lockFileSyncPath(c,user,String(src.storage_key));const source=await pathFor(options.storageRoot,String(src.storage_key));const destination=await pathFor(options.storageRoot,key);finalPath=destination;await mkdir(path.dirname(destination),{recursive:true,mode:0o700});const staged=await mkdtemp(path.join(path.dirname(destination),'.copy-stage-')).then(d=>path.join(d,'content'));temp=staged;await copyFile(source,staged)
   let row:Row
   if(target){row=(await c.query<Row>(`UPDATE files SET size=$3,size_bytes=$4,mime_type=$5,img_width=$6,img_height=$7,stage_name=$8,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND user_id=$2 RETURNING *`,[target.id,user,src.size,src.size_bytes,src.mime_type,src.img_width,src.img_height,src.stage_name])).rows[0];await updateFileStorageQuota(c,user,Number(row.id),Number(src.size_bytes)-Number(target.size_bytes),'file_copy_overwrite',`file-copy-overwrite:${row.id}:${Number(row.version)}`)}
   else {row=(await c.query<Row>(`INSERT INTO files(user_id,display_name,ext,space,project_id,folder_id,workspace_directory_id,stage_name,storage_key,storage_backend,version,size,size_bytes,mime_type,img_width,img_height,created_at,updated_at,deleted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'local',1,$10,$11,$12,$13,$14,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL) RETURNING *`,[user,display,src.ext,space,projectId,input.folderId,workspaceId,src.stage_name,key,src.size,src.size_bytes,src.mime_type,src.img_width,src.img_height])).rows[0];await updateFileStorageQuota(c,user,Number(row.id),Number(row.size_bytes),'file_copy',`file-copy:${row.id}`)}
   if(target){rollback=`${staged}.old`;await rename(destination,rollback);applied=true}await rename(staged,destination);applied=true
   if(metadata.undoContextId){const ref=`file:${row.id}`,snap=(r:Row)=>({id:Number(r.id),display_name:r.display_name,ext:r.ext,space:r.space,project_id:r.project_id,folder_id:r.folder_id,workspace_directory_id:r.workspace_directory_id,stage_name:r.stage_name,storage_key:r.storage_key,version:Number(r.version),size:r.size,size_bytes:Number(r.size_bytes),mime_type:r.mime_type,img_width:r.img_width,img_height:r.img_height,deleted_at:null});await c.query(`INSERT INTO undo_operations(id,user_id,undo_context_id,group_id,resource,action,target_refs,before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at,expires_at) VALUES($1,$2,$3,$4,'files','create',$5::json,'{}'::json,$6::json,$7::json,'{}'::json,'web','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '30 days')`,[`op-${randomUUID().replaceAll('-','')}`,user,metadata.undoContextId.slice(0,128),`group-${randomUUID().replaceAll('-','')}`,JSON.stringify([{kind:'file',id:Number(row.id)}]),JSON.stringify({items:{[ref]:snap(row)}}),JSON.stringify({[ref]:{version:0}})])}
   await recordCanonicalFileChange(c,{ownerId:user,storageRoot:options.storageRoot,storageKey:key,observedFingerprint:createHash('sha256').update(await readFile(destination)).digest('hex'),enabled:options.fileSyncEnabled})
   await c.query('COMMIT');committed=true;if(rollback)await rm(rollback,{force:true});const result=response(row,project,folder?.name??null);await options.publishChanged({ownerId:user,entityId:Number(row.id),payload:result,origin:metadata.clientId,operation:'create'}).catch(()=>undefined);return result
  }catch(e){if(!committed){await c.query('ROLLBACK').catch(()=>undefined);if(applied&&finalPath)await rm(finalPath,{force:true}).catch(()=>undefined);if(rollback&&finalPath)await rename(rollback,finalPath).catch(()=>undefined)}throw e}finally{if(temp)await rm(path.dirname(temp),{recursive:true,force:true}).catch(()=>undefined);c.release()}
 }}
}
