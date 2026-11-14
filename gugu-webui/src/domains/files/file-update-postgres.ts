import { CoreError } from '@gugu/core'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import type { WriteRequestMetadata } from '../../app.js'
import type { FileUpdateInput, FileUpdateOperations } from './file-update.js'
import { normalizeFileOwnerId } from './file-owner.js'
import { createLocalPathMirrorMutation } from './local-path-mirror.js'
import { lockFileSyncPath } from './persistence/file-sync-canonical-change.js'

type Row = QueryResultRow & Record<string, any>
type Folder = { id: number; parentId: number | null; name: string; projectId: number | null; workspaceId: number | null }
const TEXT_EXTS = new Set('md markdown txt text json csv tsv yaml yml xml html htm css js ts jsx tsx py java c cpp h hpp go rs rb php sh bash sql ini toml conf log vue svg env m3u m3u8'.split(' '))
const BINARY_EXTS = new Set('pdf doc docx odt rtf xls xlsx ods ppt pptx odp pyc'.split(' '))

function nullableId(value: unknown): number | null { return value == null ? null : Number(value) }
function safeName(value: string): string {
  const name = value.trim()
  if (!name || name === '.' || name === '..' || name.length > 300 || /[\\/:*?"<>|]/.test(name))
    throw new CoreError('invalid_request', '文件名无效')
  return name
}
function segments(value: string): string[] {
  return value.split('/').filter(Boolean).map((part) => {
    if (part === '.' || part === '..' || part.includes('\\') || part.includes('\0')) throw new CoreError('not_found', '文件不存在')
    return part
  })
}

async function folderPath(client: PoolClient, userId: string, folderId: number, projectId: number | null, workspaceId: number | null): Promise<{ names: string[]; name: string }> {
  const rows = await client.query<Row>(`WITH RECURSIVE chain AS (
    SELECT id,parent_id,name,project_id,workspace_directory_id,0 depth FROM folders
    WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
    UNION ALL SELECT f.id,f.parent_id,f.name,f.project_id,f.workspace_directory_id,c.depth+1
    FROM folders f JOIN chain c ON c.parent_id=f.id WHERE f.user_id=$2 AND f.deleted_at IS NULL AND c.depth<64
  ) SELECT * FROM chain ORDER BY depth DESC`, [folderId,userId])
  if (!rows.rows.length || rows.rows[0].parent_id !== null) throw new CoreError('not_found', '目标文件夹不存在，或不属于目标空间')
  const leaf = rows.rows.at(-1)!
  if (Number(leaf.project_id ?? 0) !== Number(projectId ?? 0) || Number(leaf.workspace_directory_id ?? 0) !== Number(workspaceId ?? 0)
    || rows.rows.some((row: Row) => Number(row.project_id ?? 0) !== Number(projectId ?? 0) || Number(row.workspace_directory_id ?? 0) !== Number(workspaceId ?? 0)))
    throw new CoreError('not_found', '目标文件夹不存在，或不属于目标空间')
  return { names: rows.rows.map((row: Row) => String(row.name).replace(/[\\/:*?"<>|]/g, '_')), name: String(leaf.name) }
}

async function fileResponse(client: PoolClient, row: Row): Promise<Record<string, unknown>> {
  const related = await client.query<Row>(`SELECT p.name project_name,p.color project_color,f.name folder_name
    FROM files file LEFT JOIN projects p ON p.id=file.project_id AND p.user_id=file.user_id
    LEFT JOIN folders f ON f.id=file.folder_id AND f.user_id=file.user_id WHERE file.id=$1 AND file.user_id=$2`, [row.id,row.user_id])
  const r = related.rows[0] ?? {}
  return {
    id:Number(row.id),displayName:row.display_name,ext:row.ext,space:row.space,
    workspaceDirectoryId:nullableId(row.workspace_directory_id),projectId:nullableId(row.project_id),
    projectName:r.project_name ?? null,projectColor:r.project_color?.match(/#[0-9a-fA-F]{3,6}/)?.[0] ?? r.project_color ?? null,
    stageName:row.stage_name,folderId:nullableId(row.folder_id),folderName:r.folder_name ?? null,
    mindMapId:nullableId(row.mind_map_id),size:row.size,sizeBytes:Number(row.size_bytes),mimeType:row.mime_type,
    createdAt:row.created_at instanceof Date?row.created_at.toISOString():String(row.created_at).replace(/Z?$/,'Z'),
    deletedAt:null,imgWidth:nullableId(row.img_width),imgHeight:nullableId(row.img_height),version:Number(row.version),
  }
}

function undoSnapshot(row: Row) {
  return { id:Number(row.id),display_name:row.display_name,ext:row.ext,space:row.space,project_id:nullableId(row.project_id),
    folder_id:nullableId(row.folder_id),workspace_directory_id:nullableId(row.workspace_directory_id),stage_name:row.stage_name,
    mind_map_id:nullableId(row.mind_map_id),storage_key:row.storage_key,version:Number(row.version),size:row.size,
    size_bytes:Number(row.size_bytes),mime_type:row.mime_type,img_width:nullableId(row.img_width),img_height:nullableId(row.img_height),deleted_at:null }
}

export function createPostgresFileUpdateOperations(pool: Pool, options: {
  storageRoot: string
  publishChanged(event:{ownerId:string;entityId:number;payload:Record<string,unknown>;origin:string|null}):Promise<void>
}): FileUpdateOperations {
  return { async update(rawOwner, id, input: FileUpdateInput, metadata: WriteRequestMetadata) {
    const userId=normalizeFileOwnerId(rawOwner), client=await pool.connect()
    let mutation: ReturnType<typeof createLocalPathMirrorMutation> | null=null, applied=false, committed=false
    try {
      await client.query('BEGIN')
      const found=await client.query<Row>('SELECT * FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE',[id,userId])
      const before=found.rows[0]
      if(!before) throw new CoreError('not_found','文件不存在')
      if(Number(before.version)!==input.version) throw new CoreError('conflict','文件已被其他端修改，请刷新后重试')
      const display=safeName(input.displayName ?? before.display_name)
      const rawExt=input.ext?.trim().toUpperCase()
      if(rawExt!=null&&(!/^[A-Z0-9_-]{1,10}$/.test(rawExt)||rawExt==='FILE')) throw new CoreError('invalid_request','后缀格式无效')
      const ext=(rawExt == null || rawExt.toLowerCase()===String(before.ext).toLowerCase())?String(before.ext):rawExt.toLowerCase()
      const mime=String(before.mime_type??'').toLowerCase(), wasText=TEXT_EXTS.has(String(before.ext).toLowerCase())||mime.startsWith('text/')||mime.endsWith('+json')||mime.endsWith('+xml')
        || ['application/json','application/xml','application/javascript','application/typescript','application/sql','application/x-sh'].includes(mime)
      if(ext!==String(before.ext).toLowerCase() && (wasText&&BINARY_EXTS.has(ext)||!wasText&&TEXT_EXTS.has(ext)))
        throw new CoreError('invalid_request','不能仅通过改后缀在文本和二进制类型间转换；改名不会转换文件内容')
      const stage=input.stageName ?? before.stage_name
      let pid=input.projectSet?input.projectId??null:nullableId(before.project_id)
      let wid=input.workspaceDirectorySet?input.workspaceDirectoryId??null:nullableId(before.workspace_directory_id)
      let fid=input.folderSet?input.folderId??null:nullableId(before.folder_id)
      let space:string
      let project:Row|null=null, workspaceName:string|null=null, names:string[]=[]
      if(wid!==null){
        space='workspace'; pid=null
        if(!input.folderSet && nullableId(before.workspace_directory_id)!==wid) fid=null
        const w=await client.query<Row>('SELECT directory_name FROM workspace_directories WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',[wid,userId])
        workspaceName=w.rows[0]?.directory_name??null
        if(!workspaceName) throw new CoreError('not_found','Workspace 不存在')
      } else if(pid!==null){
        space='project'
        const p=await client.query<Row>(`SELECT id,name,color,COALESCE(to_char(start_date,'YYYY'),to_char(created_at,'YYYY')) AS year_value,
          COALESCE(to_char(start_date,'MM'),to_char(created_at,'MM')) AS month_value FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,[pid,userId])
        project=p.rows[0]??null
        if(!project) throw new CoreError('not_found','目标项目不存在')
      } else { space='personal'; pid=null; wid=null }
      if(fid!==null) names=(await folderPath(client,userId,fid,pid,wid)).names
      const base=space==='project'?[userId,'项目文件',String(project!.year_value),String(project!.month_value),`${project!.name} #${pid}`,...names]:
        space==='workspace'?[userId,'workspace',String(workspaceName),...names]:[userId,'个人文件',...names]
      const parent=base.map((part)=>String(part).replace(/[\\/:*?"<>|]/g,'_')).join('/')
      const filename=`${display}${ext?'.'+ext:''}`, newKey=`${parent}/${filename}`
      let key=newKey, newDisplay=display, suffix=1
      if(key!==before.storage_key){
        await lockFileSyncPath(client,userId,String(before.storage_key)); await lockFileSyncPath(client,userId,key)
        while(true){
          const disk=path.join(options.storageRoot,...segments(key)); const statExists=await lstat(disk).then(()=>true,(e:NodeJS.ErrnoException)=>e.code==='ENOENT'?false:Promise.reject(e))
          const db=await client.query('SELECT 1 FROM files WHERE user_id=$1 AND storage_key=$2 AND deleted_at IS NULL AND id<>$3',[userId,key,id])
          if(!statExists&&!db.rowCount) break
          newDisplay=`${display}(${suffix++})`; key=`${parent}/${newDisplay}${ext?'.'+ext:''}`
        }
        mutation=createLocalPathMirrorMutation(options.storageRoot,userId,[{fromKey:String(before.storage_key),toKey:key}],[parent],[])
        await mutation.apply(); applied=true
      }
      const result=await client.query<Row>(`UPDATE files SET display_name=$4,ext=$5,stage_name=$6,folder_id=$7,project_id=$8,
        workspace_directory_id=$9,space=$10,storage_key=$11,version=version+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=$1 AND user_id=$2 AND version=$3 AND deleted_at IS NULL RETURNING *`,
        [id,userId,input.version,newDisplay,ext,stage,fid,pid,wid,space,key])
      const after=result.rows[0]; if(!after) throw new CoreError('conflict','文件已被其他端修改，请刷新后重试')
      const context=metadata.undoContextId?.trim().slice(0,128)
      if(context){
        const ref=`file:${id}`
        await client.query(`UPDATE undo_operations SET status='expired',failure_code='redo_cleared_by_new_operation'
          WHERE user_id=$1 AND undo_context_id=$2 AND actor_type='web' AND status='undone'`,[userId,context])
        await client.query(`INSERT INTO undo_operations(id,user_id,undo_context_id,group_id,resource,action,target_refs,before_state,after_state,
          base_versions,artifact_refs,actor_type,status,created_at,expires_at,undone_at,failure_code)
          VALUES($1,$2,$3,$4,'files','update',$5::json,$6::json,$7::json,$8::json,'{}'::json,'web','active',CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP+INTERVAL '30 days',NULL,NULL)`,[`op-${randomUUID().replaceAll('-','')}`,userId,context,`group-${randomUUID().replaceAll('-','')}`,
          JSON.stringify([{kind:'file',id}]),JSON.stringify({items:{[ref]:undoSnapshot(before)}}),JSON.stringify({items:{[ref]:undoSnapshot(after)}}),
          JSON.stringify({[ref]:{version:Number(before.version)}})])
      }
      await client.query('COMMIT'); committed=true
      if(mutation) await mutation.finalize().catch(()=>undefined)
      const payload=await fileResponse(client,after)
      await options.publishChanged({ownerId:userId,entityId:id,payload,origin:metadata.clientId}).catch(()=>undefined)
      return payload
    } catch(error){
      if(!committed){await client.query('ROLLBACK').catch(()=>undefined);if(applied&&mutation)await mutation.rollback().catch(()=>undefined)}
      throw error
    } finally { client.release() }
  } }
}
