import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { WriteRequestMetadata } from '../../app.js'
import { writeRequestMetadata } from '../../http/request.js'
import { randomUUID, createHash } from 'node:crypto'
import { lstat, mkdir, realpath, stat, copyFile, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { createLocalPathMirrorMutation } from './storage/paths.js'
import { lockFileSyncPath, recordCanonicalFileChange } from './storage/sync.js'
import { isPathWithin } from '../../shared/path-safety.js'
import { runBestEffort } from '../../shared/best-effort.js'

export interface FileUpdateInput {
  version: number
  displayName?: string | null
  ext?: string | null
  stageName?: string | null
  folderPath?: string | null
  projectId?: number | null
  workspaceDirectoryId?: number | null
  folderPathSet: boolean
  projectSet: boolean
  workspaceDirectorySet: boolean
}

export interface FileUpdateReceipt { operationId:string; fingerprint:string; method:'agent.file.rename'; previousName?:string }

export interface FileUpdateOperations {
  update(ownerId: string, storageKey: string, input: FileUpdateInput, metadata: WriteRequestMetadata,
    operation?:{receipt:FileUpdateReceipt;signal?:AbortSignal;authorize(client:import('pg').PoolClient):Promise<void>}): Promise<unknown>
}

export interface FileUpdateRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileUpdateOperations
}

function parseBody(value: unknown): FileUpdateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('invalid_request', '文件更新参数无效')
  const body = value as Record<string, unknown>
  const nullableText = (field: string, max: number): string | null | undefined => {
    const entry = body[field]
    if (entry === undefined || entry === null) return entry
    if (typeof entry !== 'string' || entry.length > max) throw new CoreError('invalid_request', `${field} 无效`)
    return entry
  }
  const nullableId = (field: string): number | null | undefined => {
    const entry = body[field]
    if (entry === undefined || entry === null) return entry
    if (!Number.isSafeInteger(entry) || Number(entry) < 1) throw new CoreError('invalid_request', `${field} 无效`)
    return Number(entry)
  }
  const nullablePath = (field: string): string | null | undefined => {
    const entry = body[field]
    if (entry === undefined || entry === null) return entry
    if (typeof entry !== 'string' || entry.length > 2048 || entry.startsWith('/'))
      throw new CoreError('invalid_request', `${field} 无效`)
    return segments(entry).join('/')
  }
  const version = body.version
  if (!Number.isSafeInteger(version) || Number(version) < 1) throw new CoreError('invalid_request', '文件版本无效')
  const ext = nullableText('ext', 10)
  if (ext != null && !/^[A-Za-z0-9_-]{1,10}$/.test(ext)) throw new CoreError('invalid_request', '后缀格式无效')
  return {
    version: Number(version), displayName: nullableText('displayName', 300), ext, stageName: nullableText('stageName', 100),
    folderPath: nullablePath('folderPath'), projectId: nullableId('projectId'), workspaceDirectoryId: nullableId('workspaceDirectoryId'),
    folderPathSet: Object.hasOwn(body, 'folderPath'), projectSet: Object.hasOwn(body, 'projectId'),
    workspaceDirectorySet: Object.hasOwn(body, 'workspaceDirectoryId'),
  }
}

export function registerFileUpdateRoutes(app: FastifyInstance, options: FileUpdateRouteOptions): void {
  app.patch('/api/v1/files/by-path', { preHandler: options.requireUser }, async (request) =>
    options.operations.update(options.ownerIdFromRequest(request), fileStorageKey(request), parseBody(request.body), writeRequestMetadata(request, { limitHeaders: true })))
}

function fileStorageKey(request: FastifyRequest): string {
  const value = (request.query as Record<string, unknown>).path
  if (typeof value !== 'string' || !value || value.length > 4096 || value.startsWith('/')
    || value.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
    throw new CoreError('invalid_request', '文件路径无效')
  return value
}

type UpdateRow = QueryResultRow & Record<string, any>

type Folder = { id: number; parentId: number | null; name: string; projectId: number | null; workspaceId: number | null }

const TEXT_EXTS = new Set('md markdown txt text json csv tsv yaml yml xml html htm css js ts jsx tsx py java c cpp h hpp go rs rb php sh bash sql ini toml conf log vue svg env m3u m3u8'.split(' '))

const BINARY_EXTS = new Set('pdf doc docx odt rtf xls xlsx ods ppt pptx odp pyc'.split(' '))

function nullableId(value: unknown): number | null { return value == null ? null : Number(value) }

function relativeFolderPath(space: unknown, storageKey: unknown): string {
  const prefixLength = space === 'project' ? 5 : space === 'workspace' ? 3 : 2
  return path.posix.dirname(String(storageKey)).split('/').slice(prefixLength).join('/')
}

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

async function fileResponse(client: Pick<PoolClient, 'query'>, row: UpdateRow): Promise<Record<string, unknown>> {
  const related = await client.query<UpdateRow>(`SELECT p.name project_name,p.color project_color
    FROM files file LEFT JOIN projects p ON p.id=file.project_id AND p.user_id=file.user_id
    WHERE file.path=$1 AND file.user_id=$2`, [row.path,row.user_id])
  const r = related.rows[0] ?? {}
  return {
    filePath:String(row.path),displayName:row.display_name,ext:row.ext,space:row.space,
    workspaceDirectoryId:nullableId(row.workspace_directory_id),projectId:nullableId(row.project_id),
    projectName:r.project_name ?? null,projectColor:r.project_color?.match(/#[0-9a-fA-F]{3,6}/)?.[0] ?? r.project_color ?? null,
    stageName:row.stage_name,folderPath:relativeFolderPath(row.space,row.path),
    mindMapId:nullableId(row.mind_map_id),size:row.size,sizeBytes:Number(row.size_bytes),mimeType:row.mime_type,
    createdAt:row.created_at instanceof Date?row.created_at.toISOString():String(row.created_at).replace(/Z?$/,'Z'),
    deletedAt:null,imgWidth:nullableId(row.img_width),imgHeight:nullableId(row.img_height),version:Number(row.version),
  }
}

async function readRenameReceipt(client:Pick<PoolClient,'query'>,owner:string,receipt:FileUpdateReceipt):Promise<Record<string,unknown>|null>{
  const found=await client.query<{method:string;fingerprint:string;result_json:string}>(
    'SELECT method,fingerprint,result_json FROM core_operation_receipts WHERE owner_id=$1 AND operation_id=$2',[owner,receipt.operationId])
  const row=found.rows[0];if(!row)return null
  if(row.method!==receipt.method||row.fingerprint!==receipt.fingerprint)throw new CoreError('conflict','操作标识已用于不同内容')
  let value:unknown;try{value=JSON.parse(row.result_json)}catch{throw new CoreError('storage_error','文件重命名回执无效')}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new CoreError('storage_error','文件重命名回执无效')
  return value as Record<string,unknown>
}

function undoSnapshot(row: UpdateRow) {
  return { display_name:row.display_name,ext:row.ext,space:row.space,project_id:nullableId(row.project_id),
    workspace_directory_id:nullableId(row.workspace_directory_id),stage_name:row.stage_name,
    mind_map_id:nullableId(row.mind_map_id),path:row.path,version:Number(row.version),size:row.size,
    size_bytes:Number(row.size_bytes),mime_type:row.mime_type,img_width:nullableId(row.img_width),img_height:nullableId(row.img_height),deleted_at:null }
}

export function createPostgresFileUpdateOperations(pool: Pool, options: {
  storageRoot: string
  publishChanged(event:{ownerId:string;entityId:string;payload:Record<string,unknown>;origin:string|null}):Promise<void>
}): FileUpdateOperations {
  return { async update(rawOwner, storageKey, input: FileUpdateInput, metadata: WriteRequestMetadata, operation) {
    const userId=normalizeFileOwnerId(rawOwner), client=await pool.connect()
    let mutation: ReturnType<typeof createLocalPathMirrorMutation> | null=null, applied=false, committed=false, preserveMutationForRecovery=false
    let releaseError: Error | undefined
    try {
      await client.query('BEGIN')
      operation?.signal?.throwIfAborted()
      await operation?.authorize(client)
      if(operation){
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${userId}:${operation.receipt.operationId}`])
        const previous=await readRenameReceipt(client,userId,operation.receipt)
        if(previous){await client.query('COMMIT');committed=true;return {file:previous,replayed:true}}
      }
      const found=await client.query<UpdateRow>('SELECT * FROM files WHERE path=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE',[storageKey,userId])
      const before=found.rows[0]
      if(!before) throw new CoreError('not_found','文件不存在')
      if(Number(before.version)!==input.version) throw new CoreError('conflict','文件已被其他端修改，请刷新后重试')
      const display=safeName(input.displayName ?? before.display_name)
      const rawExt=input.ext?.trim().toUpperCase()
      if(rawExt!=null&&(!/^[A-Z0-9][A-Z0-9._+\-]{0,19}$/i.test(rawExt)||rawExt==='FILE')) throw new CoreError('invalid_request','后缀格式无效')
      const ext=(rawExt == null || rawExt.toLowerCase()===String(before.ext).toLowerCase())?String(before.ext):rawExt.toLowerCase()
      const mime=String(before.mime_type??'').toLowerCase(), wasText=TEXT_EXTS.has(String(before.ext).toLowerCase())||mime.startsWith('text/')||mime.endsWith('+json')||mime.endsWith('+xml')
        || ['application/json','application/xml','application/javascript','application/typescript','application/sql','application/x-sh'].includes(mime)
      if(ext!==String(before.ext).toLowerCase() && (wasText&&BINARY_EXTS.has(ext)||!wasText&&TEXT_EXTS.has(ext)))
        throw new CoreError('invalid_request','不能仅通过改后缀在文本和二进制类型间转换；改名不会转换文件内容')
      const stage=input.stageName ?? before.stage_name
      let pid=input.projectSet?input.projectId??null:nullableId(before.project_id)
      let wid=input.workspaceDirectorySet?input.workspaceDirectoryId??null:nullableId(before.workspace_directory_id)
      let space:string
      let project:UpdateRow|null=null, workspaceName:string|null=null
      if(wid!==null){
        space='workspace'; pid=null
        const w=await client.query<UpdateRow>('SELECT directory_name FROM workspace_directories WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',[wid,userId])
        workspaceName=w.rows[0]?.directory_name??null
        if(!workspaceName) throw new CoreError('not_found','Workspace 不存在')
      } else if(pid!==null){
        space='project'
        const p=await client.query<UpdateRow>(`SELECT id,name,color,COALESCE(to_char(NULLIF(start_date::text,'')::date,'YYYY'),to_char(created_at,'YYYY')) AS year_value,
          COALESCE(to_char(NULLIF(start_date::text,'')::date,'MM'),to_char(created_at,'MM')) AS month_value FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,[pid,userId])
        project=p.rows[0]??null
        if(!project) throw new CoreError('not_found','目标项目不存在')
      } else { space='personal'; pid=null; wid=null }
      const base=space==='project'?[userId,'项目文件',String(project!.year_value),String(project!.month_value),`${project!.name} #${pid}`]:
        space==='workspace'?[userId,'workspace',String(workspaceName)]:[userId,'个人文件']
      const sameScope = String(before.space) === space
        && Number(before.project_id ?? 0) === Number(pid ?? 0)
        && Number(before.workspace_directory_id ?? 0) === Number(wid ?? 0)
      const names = input.folderPathSet
        ? segments(input.folderPath ?? '')
        : sameScope
          ? path.posix.dirname(String(before.path)).split('/').slice(base.length)
          : []
      const parent=base.map((part)=>String(part).replace(/[\\/:*?"<>|]/g,'_')).join('/')
      const targetParent=[parent,...names.map((part)=>part.replace(/[\\:*?"<>|]/g,'_'))].join('/')
      const filename=`${display}${ext?'.'+ext:''}`, newKey=`${targetParent}/${filename}`
      let key=newKey, newDisplay=display, suffix=1
      if(key!==before.path){
        await lockFileSyncPath(client,userId,String(before.path)); await lockFileSyncPath(client,userId,key)
        while(true){
          const disk=path.join(options.storageRoot,...segments(key)); const statExists=await lstat(disk).then(()=>true,(e:NodeJS.ErrnoException)=>e.code==='ENOENT'?false:Promise.reject(e))
          const db=await client.query('SELECT 1 FROM files WHERE user_id=$1 AND path=$2 AND deleted_at IS NULL',[userId,key])
          if(!statExists&&!db.rowCount) break
          newDisplay=`${display}(${suffix++})`; key=`${parent}/${newDisplay}${ext?'.'+ext:''}`
        }
        mutation=createLocalPathMirrorMutation(options.storageRoot,userId,[{fromKey:String(before.path),toKey:key,preserveSourceUntilFinalize:true}],[parent],[])
        await mutation.apply(); applied=true
      }
      const result=await client.query<UpdateRow>(`UPDATE files SET display_name=$4,ext=$5,stage_name=$6,project_id=$7,
        workspace_directory_id=$8,space=$9,path=$10,version=version+1,updated_at=CURRENT_TIMESTAMP
        WHERE path=$1 AND user_id=$2 AND version=$3 AND deleted_at IS NULL RETURNING *`,
        [storageKey,userId,input.version,newDisplay,ext,stage,pid,wid,space,key])
      const after=result.rows[0]; if(!after) throw new CoreError('conflict','文件已被其他端修改，请刷新后重试')
      const context=metadata.undoContextId?.trim().slice(0,128)
      if(context){
        const ref=`file:${before.path}`
        await client.query(`UPDATE undo_operations SET status='expired',failure_code='redo_cleared_by_new_operation'
          WHERE user_id=$1 AND undo_context_id=$2 AND actor_type='web' AND status='undone'`,[userId,context])
        await client.query(`INSERT INTO undo_operations(id,user_id,undo_context_id,group_id,resource,action,target_refs,before_state,after_state,
          base_versions,artifact_refs,actor_type,status,created_at,expires_at,undone_at,failure_code)
          VALUES($1,$2,$3,$4,'files','update',$5::json,$6::json,$7::json,$8::json,'{}'::json,'web','active',CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP+INTERVAL '30 days',NULL,NULL)`,[`op-${randomUUID().replaceAll('-','')}`,userId,context,`group-${randomUUID().replaceAll('-','')}`,
          JSON.stringify([{kind:'file',path:before.path}]),JSON.stringify({items:{[ref]:undoSnapshot(before)}}),JSON.stringify({items:{[ref]:undoSnapshot(after)}}),
          JSON.stringify({[ref]:{version:Number(before.version)}})])
      }
      const payload=await fileResponse(client,after)
      if(operation){
        operation.signal?.throwIfAborted()
        await client.query(`INSERT INTO core_operation_receipts(owner_id,operation_id,method,fingerprint,result_json,created_at)
          VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)`,[userId,operation.receipt.operationId,operation.receipt.method,
          operation.receipt.fingerprint,JSON.stringify({ ...payload,
            ...(operation.receipt.previousName !== undefined ? { old_name: operation.receipt.previousName } : {}) })])
      }
      try {
        await client.query('COMMIT')
        committed=true
      } catch (commitError) {
        releaseError=commitError instanceof Error?commitError:new Error('COMMIT 结果未知')
        const persisted=await pool.query<UpdateRow>('SELECT path,version FROM files WHERE path=ANY($1::text[]) AND user_id=$2 AND deleted_at IS NULL',[ [...new Set([String(before.path),String(after.path)])],userId]).catch(()=>null)
        const current=persisted?.rows ?? []
        if(current.some(row=>String(row.path)===String(after.path)&&Number(row.version)===Number(after.version))) committed=true
        else if(current.some(row=>String(row.path)===String(before.path)&&Number(row.version)===Number(before.version))) throw commitError
        else {
          preserveMutationForRecovery=true
          throw new CoreError('storage_error','文件修改提交结果暂时无法确认；原文件与目标文件均已保留，请稍后检查文件状态')
        }
      }
      if(mutation) await mutation.finalize().catch(()=>undefined)
      await options.publishChanged({ownerId:userId,entityId:String(after.path),payload,origin:metadata.clientId}).catch(()=>undefined)
      return operation?{file:payload,replayed:false}:payload
    } catch(error){
      if(!committed&&!preserveMutationForRecovery){await client.query('ROLLBACK').catch(()=>undefined);if(applied&&mutation)await mutation.rollback().catch(()=>undefined)}
      throw error
    } finally { client.release(releaseError) }
  } }
}

export interface FileCopyInput {
  folderPath: string | null
  projectId: number | null
  workspaceDirectoryId: number | null
  onConflict: 'keep_both' | 'overwrite'
  overwriteFilePath: string | null
}

export interface FileCopyReceipt { operationId:string; fingerprint:string; method:'agent.file.copy' }

export interface FileCopyOperations {
  copy(ownerId:string,storageKey:string,input:FileCopyInput,metadata:WriteRequestMetadata,
    operation?:{receipt:FileCopyReceipt;signal?:AbortSignal;authorize(client:import('pg').PoolClient):Promise<void>}):Promise<unknown>
}

export interface FileCopyRouteOptions { requireUser:preHandlerHookHandler; ownerIdFromRequest(request:FastifyRequest):string; operations:FileCopyOperations }

function id(value:unknown,field:string):number|null {
  if(value===undefined||value===null)return null
  if(!Number.isSafeInteger(value)||Number(value)<1)throw new CoreError('invalid_request',`${field} 无效`)
  return Number(value)
}

export function registerFileCopyRoutes(app:FastifyInstance,options:FileCopyRouteOptions):void {
  app.post('/api/v1/files/by-path/copy',{preHandler:options.requireUser},async request=>{
    if(!request.body||typeof request.body!=='object'||Array.isArray(request.body))throw new CoreError('invalid_request','复制参数无效')
    const body=request.body as Record<string,unknown>
    const onConflict=body.onConflict??'keep_both'
    if(onConflict!=='keep_both'&&onConflict!=='overwrite')throw new CoreError('invalid_request','冲突处理方式无效')
    const overwriteFilePath=body.overwriteFilePath
    if(overwriteFilePath!==undefined&&overwriteFilePath!==null&&(typeof overwriteFilePath!=='string'||overwriteFilePath.length>4096||overwriteFilePath.startsWith('/')||overwriteFilePath.split('/').some(part=>!part||part==='.'||part==='..'||part.includes('\\')||part.includes('\0'))))throw new CoreError('invalid_request','overwriteFilePath 无效')
    if(onConflict==='overwrite'&&typeof overwriteFilePath!=='string')throw new CoreError('invalid_request','覆盖复制缺少目标路径')
    if(onConflict==='keep_both'&&overwriteFilePath!=null)throw new CoreError('invalid_request','保留两者时不能指定覆盖目标')
    const folderPath=body.folderPath
    if(folderPath!==undefined&&folderPath!==null&&(typeof folderPath!=='string'||folderPath.length>2048||folderPath.startsWith('/')))
      throw new CoreError('invalid_request','folderPath 无效')
    return options.operations.copy(options.ownerIdFromRequest(request),fileStorageKey(request),{
      folderPath:folderPath==null?null:segments(folderPath as string).join('/'),projectId:id(body.projectId,'projectId'),
      workspaceDirectoryId:id(body.workspaceDirectoryId,'workspaceDirectoryId'),onConflict,overwriteFilePath:typeof overwriteFilePath==='string'?overwriteFilePath:null,
    },writeRequestMetadata(request, { limitHeaders: true }))
  })
}

type CopyRow=QueryResultRow & Record<string,any>

async function pathFor(rootPath:string,key:string):Promise<string>{
  const parts=key.split('/');if(parts.length<2||parts.some(p=>!p||p==='.'||p==='..'||p.includes('\\')||p.includes('\0')))throw new CoreError('not_found','文件不存在')
  const root=await realpath(rootPath);let target=root
  for(const part of parts){target=path.resolve(target,part);if(!isPathWithin(root,target))throw new CoreError('not_found','文件不存在');try{if((await lstat(target)).isSymbolicLink())throw new CoreError('not_found','文件不存在')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}}
  return target
}

function response(row:CopyRow,target:CopyRow|null){return {filePath:String(row.path),displayName:row.display_name,ext:row.ext,space:row.space,workspaceDirectoryId:row.workspace_directory_id==null?null:Number(row.workspace_directory_id),projectId:row.project_id==null?null:Number(row.project_id),projectName:target?.name??null,projectColor:target?.color?.match(/#[0-9a-fA-F]{3,6}/)?.[0]??target?.color??null,stageName:row.stage_name,folderPath:relativeFolderPath(row.space,row.path),mindMapId:row.mind_map_id==null?null:Number(row.mind_map_id),size:row.size,sizeBytes:Number(row.size_bytes),mimeType:row.mime_type,createdAt:row.created_at instanceof Date?row.created_at.toISOString():String(row.created_at).replace(/Z?$/,'Z'),deletedAt:null,imgWidth:row.img_width==null?null:Number(row.img_width),imgHeight:row.img_height==null?null:Number(row.img_height),version:Number(row.version)}}

async function readCopyReceipt(client:Pick<PoolClient,'query'>,owner:string,receipt:FileCopyReceipt):Promise<Record<string,unknown>|null>{
 const found=await client.query<{method:string;fingerprint:string;result_json:string}>('SELECT method,fingerprint,result_json FROM core_operation_receipts WHERE owner_id=$1 AND operation_id=$2',[owner,receipt.operationId])
 const row=found.rows[0];if(!row)return null
 if(row.method!==receipt.method||row.fingerprint!==receipt.fingerprint)throw new CoreError('conflict','操作标识已用于不同内容')
 let result:unknown;try{result=JSON.parse(row.result_json)}catch{throw new CoreError('storage_error','文件复制回执无效')}
 if(!result||typeof result!=='object'||Array.isArray(result))throw new CoreError('storage_error','文件复制回执无效')
 return result as Record<string,unknown>
}

export function createPostgresFileCopyOperations(pool:Pool,options:{storageRoot:string;fileSyncEnabled:boolean;removeCommittedBackup?:(backupPath:string)=>Promise<void>;restoreBackup?:typeof rename;recordFileChange?:typeof recordCanonicalFileChange;publishChanged(e:{ownerId:string;entityId:string;payload:Record<string,unknown>;origin:string|null;operation:'create'}):Promise<void>}):FileCopyOperations{
 return {async copy(rawOwner,storageKey,input:FileCopyInput,metadata:WriteRequestMetadata,operation){
  const user=/^[0-9a-f-]{36}$/i.test(rawOwner)?rawOwner.toLowerCase():'';if(!user)throw new CoreError('invalid_request','用户标识无效')
  const c=await pool.connect();let mutation:ReturnType<typeof createLocalPathMirrorMutation>|null=null,applied=false,committed=false,commitAttempted=false,preserveStage=false,temp:string|null=null,finalPath:string|null=null,rollback:string|null=null
  try{
   await c.query('BEGIN');operation?.signal?.throwIfAborted();await operation?.authorize(c)
   if(operation){await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:${operation.receipt.operationId}`]);const previous=await readCopyReceipt(c,user,operation.receipt);if(previous){await c.query('COMMIT');committed=true;return {file:previous,replayed:true}}}
   const srcQ=await c.query<CopyRow>('SELECT * FROM files WHERE path=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE',[storageKey,user]);const src=srcQ.rows[0];if(!src||!isOwnedFilePath(user,String(src.path)))throw new CoreError('not_found','文件不存在')
   const projectId=input.projectId,workspaceId=input.workspaceDirectoryId
   if(projectId!==null&&workspaceId!==null)throw new CoreError('invalid_request','项目与 Workspace 目录不能同时指定')
   let project:CopyRow|null=null,workspaceName:string|null=null,space=workspaceId!==null?'workspace':projectId!==null?'project':'personal'
   if(projectId!==null){const q=await c.query<CopyRow>(`SELECT id,name,color,COALESCE(to_char(NULLIF(start_date::text,'')::date,'YYYY'),to_char(created_at,'YYYY')) year_value,COALESCE(to_char(NULLIF(start_date::text,'')::date,'MM'),to_char(created_at,'MM')) month_value FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,[projectId,user]);project=q.rows[0]??null;if(!project)throw new CoreError('not_found','目标项目不存在')}
   if(workspaceId!==null){const q=await c.query<CopyRow>('SELECT directory_name FROM workspace_directories WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',[workspaceId,user]);workspaceName=q.rows[0]?.directory_name??null;if(!workspaceName)throw new CoreError('not_found','Workspace 不存在')}
   const folderParts=segments(input.folderPath??'').map(part=>part.replace(/[\\:*?"<>|]/g,'_'))
   const parent=space==='project'?[user,'项目文件',project!.year_value,project!.month_value,`${project!.name} #${projectId}`,...folderParts]:space==='workspace'?[user,'workspace',workspaceName,...folderParts]:[user,'个人文件',...folderParts]
   const base=parent.map((x:any)=>String(x).replace(/[\\/:*?"<>|]/g,'_')).join('/')
   let targetPath=input.overwriteFilePath, display=src.display_name,key=''
   let target:CopyRow|null=null
   if(input.onConflict==='overwrite'){
    const q=await c.query<CopyRow>('SELECT * FROM files WHERE path=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE',[targetPath,user]);target=q.rows[0]??null
    if(!target)throw new CoreError('not_found','要覆盖的文件不存在')
    if(!isOwnedFilePath(user,String(target.path)))throw new CoreError('not_found','文件不存在')
    if(String(target.path)===storageKey){
   if(metadata.undoContextId){const ref=`file:${target.path}`,snap={display_name:target.display_name,ext:target.ext,space:target.space,project_id:target.project_id,workspace_directory_id:target.workspace_directory_id,stage_name:target.stage_name,path:target.path,version:Number(target.version),size:target.size,size_bytes:Number(target.size_bytes),mime_type:target.mime_type,img_width:target.img_width,img_height:target.img_height,deleted_at:null};await c.query(`INSERT INTO undo_operations(id,user_id,undo_context_id,group_id,resource,action,target_refs,before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at,expires_at) VALUES($1,$2,$3,$4,'files','create',$5::json,'{}'::json,$6::json,$7::json,'{}'::json,'web','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '30 days')`,[`op-${randomUUID().replaceAll('-','')}`,user,metadata.undoContextId.slice(0,128),`group-${randomUUID().replaceAll('-','')}`,JSON.stringify([{kind:'file',path:target.path}]),JSON.stringify({items:{[ref]:snap}}),JSON.stringify({[ref]:{version:0}})])}
      commitAttempted=true;await c.query('COMMIT');committed=true;const result=response(target,project);await options.publishChanged({ownerId:user,entityId:String(target.path),payload:result,origin:metadata.clientId,operation:'create'}).catch(()=>undefined);return result
    }
    if(target.space!==space||Number(target.project_id??0)!==Number(projectId??0)||Number(target.workspace_directory_id??0)!==Number(workspaceId??0)||path.posix.dirname(String(target.path))!==base||target.display_name!==display||String(target.ext).toLowerCase()!==String(src.ext).toLowerCase())throw new CoreError('invalid_request','覆盖目标与复制文件不匹配')
    key=String(target.path)
   }else{
    const ext=String(src.ext).toLowerCase();let n=0
    while(true){display=n?`${src.display_name}(${n})`:String(src.display_name);key=`${base}/${display}${ext?'.'+ext:''}`
     await lockFileSyncPath(c,user,key);const disk=await pathFor(options.storageRoot,key);const exists=await stat(disk).then(()=>true,(e:NodeJS.ErrnoException)=>e.code==='ENOENT'?false:Promise.reject(e));const collision=await c.query('SELECT 1 FROM files WHERE user_id=$1 AND path=$2 AND deleted_at IS NULL',[user,key]);if(!exists&&!collision.rowCount)break;n++}
   }
   await lockFileSyncPath(c,user,String(src.path));const source=await pathFor(options.storageRoot,String(src.path));const destination=await pathFor(options.storageRoot,key);finalPath=destination;await mkdir(path.dirname(destination),{recursive:true,mode:0o700});const staged=await mkdtemp(path.join(path.dirname(destination),'.copy-stage-')).then(d=>path.join(d,'content'));temp=staged;await copyFile(source,staged)
   let row:CopyRow
   if(target){row=(await c.query<CopyRow>(`UPDATE files SET size=$3,size_bytes=$4,mime_type=$5,img_width=$6,img_height=$7,stage_name=$8,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE path=$1 AND user_id=$2 RETURNING *`,[target.path,user,src.size,src.size_bytes,src.mime_type,src.img_width,src.img_height,src.stage_name])).rows[0]}
   else {row=(await c.query<CopyRow>(`INSERT INTO files(user_id,display_name,ext,space,project_id,workspace_directory_id,stage_name,path,storage_backend,version,size,size_bytes,mime_type,img_width,img_height,created_at,updated_at,deleted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'local',1,$9,$10,$11,$12,$13,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL) RETURNING *`,[user,display,src.ext,space,projectId,workspaceId,src.stage_name,key,src.size,src.size_bytes,src.mime_type,src.img_width,src.img_height])).rows[0]}
   if(target){rollback=`${staged}.old`;await rename(destination,rollback);applied=true}await rename(staged,destination);applied=true
   if(metadata.undoContextId){const ref=`file:${row.path}`,snap=(r:CopyRow)=>({display_name:r.display_name,ext:r.ext,space:r.space,project_id:r.project_id,workspace_directory_id:r.workspace_directory_id,stage_name:r.stage_name,path:r.path,version:Number(r.version),size:r.size,size_bytes:Number(r.size_bytes),mime_type:r.mime_type,img_width:r.img_width,img_height:r.img_height,deleted_at:null});await c.query(`INSERT INTO undo_operations(id,user_id,undo_context_id,group_id,resource,action,target_refs,before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at,expires_at) VALUES($1,$2,$3,$4,'files','create',$5::json,'{}'::json,$6::json,$7::json,'{}'::json,'web','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '30 days')`,[`op-${randomUUID().replaceAll('-','')}`,user,metadata.undoContextId.slice(0,128),`group-${randomUUID().replaceAll('-','')}`,JSON.stringify([{kind:'file',path:row.path}]),JSON.stringify({items:{[ref]:snap(row)}}),JSON.stringify({[ref]:{version:0}})])}
   await (options.recordFileChange??recordCanonicalFileChange)(c,{ownerId:user,storageRoot:options.storageRoot,storageKey:key,observedFingerprint:createHash('sha256').update(await readFile(destination)).digest('hex'),enabled:options.fileSyncEnabled})
   const result=response(row,project)
   if(operation){operation.signal?.throwIfAborted();await c.query(`INSERT INTO core_operation_receipts(owner_id,operation_id,method,fingerprint,result_json,created_at) VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)`,[user,operation.receipt.operationId,operation.receipt.method,operation.receipt.fingerprint,JSON.stringify(result)])}
   commitAttempted=true;await c.query('COMMIT');committed=true;if(rollback)await runBestEffort('文件复制备份清理',()=>options.removeCommittedBackup?.(rollback!)??rm(rollback!,{force:true}),()=>console.error('文件复制备份清理失败，将尝试清理暂存目录'));await options.publishChanged({ownerId:user,entityId:String(row.path),payload:result,origin:metadata.clientId,operation:'create'}).catch(()=>undefined);return operation?{file:result,replayed:false}:result
  }catch(e){if(!committed){await c.query('ROLLBACK').catch(()=>undefined);if(!commitAttempted){if(applied&&finalPath)await rm(finalPath,{force:true}).catch(()=>undefined);if(rollback&&finalPath)await Promise.resolve().then(()=>(options.restoreBackup??rename)(rollback!,finalPath!)).catch(()=>{preserveStage=true;console.error('文件复制回滚失败，保留备份供核查')})}else console.error('文件复制提交结果未知，保留文件供核查')}if(operation&&commitAttempted&&!committed)throw new CoreError('storage_error','文件复制提交结果未知');throw e}finally{if(temp&&!preserveStage&&(!commitAttempted||committed))await rm(path.dirname(temp),{recursive:true,force:true}).catch(()=>console.error('文件复制暂存目录清理失败，可能存在残留'));c.release()}
 }}
}

/** 验证 UUID 形式的文件 owner ID，并统一存为小写。 */
export function normalizeFileOwnerId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new CoreError('invalid_request', '用户标识无效')
  return value.toLowerCase()
}

/** 普通存储使用 UUID 路径，旧版数据导入使用同一用户的无连字符目录。 */
export function isOwnedFilePath(ownerId: string, key: string): boolean {
  return key.startsWith(`${ownerId}/`)
    || key.startsWith(`${ownerId.replaceAll('-', '')}/.data-portability/imported/`)
}
