import { sql } from 'kysely'
import type { SqlDataRuntime } from '../../data/runtime.js'
import { prepareMindNoteCreate, MindNoteCreateError, type MindNoteReadResponse } from '../../mind/note-create.js'
import { createBorrowedSqlMindNoteInserter } from '../../mind/note-postgres-sqlite.js'
import { createSqlMindNoteMutator } from '../../mind/note-mutations-sql.js'
import { mindBlocksSchema, serializeMindBlocks, applyMindLineEdits, replaceUniqueMindText, MindNoteContentError } from '../../mind/note-content.js'
import { strip } from '../../shared/values.js'
import { utc } from '../../shared/timestamps.js'
import { normalizeDateInput } from './date-input.js'
import { createHash } from 'node:crypto'
import { CoreError,dataContext } from '../../contracts/index.js'
import { applyNoteLifecycle } from '../../mind/note-lifecycle.js'
import { MindNoteMutationError, prepareMindNoteUpdate } from '../../mind/note-mutations.js'
import { z } from 'zod'
import { agentMindNodeDetail, type createAgentMindReader } from '../../mind/note-read.js'
import type { ToolDefinition } from './contracts.js'
import type { Json, RunIdentity, ToolResult } from '../models.js'

/** Mind组：搜索只召回note/canvas_note，详情可读同owner存活来源节点；关系与正文引用分别投影。 */
export function createNoteReadTools(reader:ReturnType<typeof createAgentMindReader>):ToolDefinition[]{
  const schemas={
    note_search:z.object({query:z.string().optional(),q:z.string().optional(),queries:z.array(z.string()).optional(),
      mode:z.enum(['OR','AND']).optional(),limit:z.number().int().safe().optional(),include_content:z.boolean().optional()}).passthrough(),
    note_get:z.object({node_id:z.number().int().safe()}).passthrough(),
  }
  return (Object.keys(schemas) as (keyof typeof schemas)[]).map(name=>({
    definition:{name,schema:{type:'function',function:{name,
      description:name==='note_search'?'搜索笔记和画布便签；related为一跳关系，references为正文中可访问的项目、文件和活动引用；include_content可返回完整正文。':'读取已知思维节点正文、原始物理行号、一跳关系和正文引用；代码示例不计入references。',
      parameters:(()=>{const value=z.toJSONSchema(schemas[name]) as Record<string,Json>;delete value.additionalProperties;return value})()}}},
    effect:'read',validate:input=>schemas[name].safeParse(input),
    async execute(input,scope){
      const value=name==='note_search'?await reader.search(scope.identity.ownerId,input as z.infer<typeof schemas.note_search>,scope.signal)
        :await reader.get(scope.identity.ownerId,(input as {node_id:number}).node_id,scope.signal)
      scope.signal.throwIfAborted()
      return {kind:'completed',successful:!('error' in value),mutated:false,value}
    },
  }))
}

export interface NoteLifecycleRequest {
  identity:import('../models.js').RunIdentity;roundId:string;toolCallId:string
  intent:import('../../mind/note-lifecycle.js').NoteLifecycleIntent
}
export interface NoteLifecyclePort {
  apply(input:NoteLifecycleRequest&{signal:AbortSignal}):Promise<import('../models.js').ToolResult>
  reconcile(input:NoteLifecycleRequest):Promise<import('../models.js').ToolResult>
}
/** 收据与生命周期/Undo共用事务；恢复绝不重新选择“最近”笔记。 */
export function createNoteLifecyclePort(core:import('../../data/runtime.js').SqlDataRuntime,publish:(event:import('../../mind/note-lifecycle.js').NoteLifecyclePublication)=>Promise<void>):NoteLifecyclePort{
  if(!core.receipts||typeof publish!=='function')throw new Error('笔记生命周期后端未装配')
  const absent=new Error('笔记调用收据不存在')
  function key(input:NoteLifecycleRequest){
    const context=dataContext(input.identity.ownerId)
    const parts=['note.lifecycle',context.ownerId,input.identity.sessionId,input.identity.runId,input.roundId,input.toolCallId]
    if(parts.some(value=>typeof value!=='string'||!value.trim()))throw new CoreError('invalid_request','工具运行身份无效')
    const hash=createHash('sha256').update(JSON.stringify(parts)).digest('hex'),id=hash.slice(0,12)+'5'+hash.slice(13,16)+'8'+hash.slice(17,32)
    return {context,operationId:[id.slice(0,8),id.slice(8,12),id.slice(12,16),id.slice(16,20),id.slice(20)].join('-')}
  }
  async function recover(input:NoteLifecycleRequest):Promise<import('../models.js').ToolResult>{
    try{const k=key(input),receipt=await core.operationWithTransaction(k.context,k.operationId,'agent.note.lifecycle',input.intent,async()=>{throw absent})
      return {kind:'completed',successful:true,mutated:false,value:receipt.result}
    }catch{return {kind:'unknown'}}
  }
  return {reconcile:recover,async apply(input){
    input.signal.throwIfAborted()
    let callbackError:unknown,publication:import('../../mind/note-lifecycle.js').NoteLifecyclePublication|undefined
    try{
      const k=key(input),receipt=await core.operationWithTransaction(k.context,k.operationId,'agent.note.lifecycle',input.intent,async tx=>{
        try{const result=await applyNoteLifecycle(tx,core.backend,k.context.ownerId,input.intent,k.operationId,input.signal);publication=result.publication;return result.value}
        catch(error){callbackError=error;throw error}
      },{signal:input.signal})
      if(!receipt.replayed&&publication){try{await publish(publication)}catch{/* 提交后的通知失败不回滚。 */}}
      return {kind:'completed',successful:true,mutated:!receipt.replayed,value:receipt.result}
    }catch(error){
      if(error===callbackError&&error instanceof MindNoteMutationError)return {kind:'completed',successful:false,mutated:false,value:{error:error.statusCode===409?(input.intent.action==='restore'?'便签状态已变化，请重新确认':input.intent.action==='undo'?'刚才的记录状态已变化，请重新确认':'便签刚被修改，请稍后重试'):error.message}}
      if(error instanceof CoreError&&error.code==='conflict')return {kind:'completed',successful:false,mutated:false,value:{error:'操作标识已用于不同内容'}}
      if(input.signal.aborted&&error===callbackError)throw error
      return recover(input)
    }
  }}
}

export function createNoteLifecycleTools(port:NoteLifecyclePort):ToolDefinition[]{
  const schemas={note_delete:z.object({node_id:z.number().int().safe()}).strict(),note_restore:z.object({node_id:z.number().int().safe()}).passthrough(),note_undo:z.object({}).passthrough()}
  const descriptions={note_delete:'软删精确node_id对应的普通便签，可由note_restore恢复；不按关键词模糊删除。',note_restore:'恢复精确node_id对应的已软删普通便签，保留正文。',note_undo:'撤销当前用户最近创建的一条咕咕笔记，不影响用户自行创建的笔记。'}
  function intent(name:keyof typeof schemas,input:unknown):import('../../mind/note-lifecycle.js').NoteLifecycleIntent{return name==='note_undo'?{action:'undo'}:{action:name==='note_restore'?'restore':'delete',node_id:(input as {node_id:number}).node_id}}
  return (Object.keys(schemas) as (keyof typeof schemas)[]).map(name=>({definition:{name,schema:{type:'function',function:{name,description:descriptions[name],parameters:z.toJSONSchema(schemas[name]) as Record<string,Json>}}},effect:'write',validate:input=>schemas[name].safeParse(input),
    execute:(input,scope,call)=>port.apply({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,intent:intent(name,input),signal:scope.signal}),
    reconcile:(input,identity,call)=>port.reconcile({identity,roundId:identity.roundId,toolCallId:call.id,intent:intent(name,input)})}))
}

const noteFields = {
  title: z.string().nullable().optional(),
  color: z.enum(['amber', 'coral', 'blue', 'teal']).nullable().optional(),
  captured_at: z.string().optional(),
}
const noteBodyModes = ['append_markdown', 'append_blocks', 'line_edits', 'find_replace'] as const
const mixedNoteBodyModes = noteBodyModes.flatMap((first, index) =>
  noteBodyModes.slice(index + 1).map(second => ({ required: [first, second] })),
)
const noteWriteSchemas = {
  note_create: z.object({ ...noteFields, title: z.string().optional(), markdown: z.string().optional(), blocks: mindBlocksSchema.optional() }).strict(),
  note_update: z.object({
    ...noteFields, node_id: z.number().int().safe(), append_markdown: z.string().optional(), append_blocks: mindBlocksSchema.optional(),
    find_replace: z.object({
      find: z.string().min(1).describe('从 note_get.content_md 逐字复制的非空原文，必须唯一匹配'),
      replace: z.string().describe('替换文字，空字符串删除该处原文'),
    }).strict().optional(),
    line_edits: z.array(z.object({ target_lines: z.string().regex(/^(all|[0-9]+([-,][0-9]+)?)$/u), content: z.string(), expected: z.string().optional() }).strict()).optional(),
  }).strict(),
}
type NoteWriteName = keyof typeof noteWriteSchemas
type NoteWriteRequest = { [N in NoteWriteName]: {
  name: N; args: z.infer<(typeof noteWriteSchemas)[N]>
  identity: RunIdentity; roundId: string; toolCallId: string
} }[NoteWriteName]
export interface NoteWritePort {
  apply(request: NoteWriteRequest, signal: AbortSignal): Promise<ToolResult>
  reconcile(request: NoteWriteRequest): Promise<ToolResult>
}

function failure(error: string, next_action?: string): ToolResult {
  return { kind: 'completed', successful: false, mutated: false, value: { error, ...(next_action ? { next_action } : {}) } }
}

/** 旧版日期归属使用 Host 本地偏移和正午锚点，显式时间必须携带偏移。 */
function capturedAt(raw: string | undefined, now: Date, timezone: string): string | undefined {
  if (raw === undefined) return undefined
  const text = strip(raw)
  if (!text) throw new MindNoteContentError('captured_at 不能为空')
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, timeZoneName: 'longOffset', year: 'numeric' })
  const parts = format.formatToParts(now)
  const year = Number(parts.find(part => part.type === 'year')?.value)
  const offset = parts.find(part => part.type === 'timeZoneName')?.value.slice(3) || '+00:00'
  const day = normalizeDateInput(text, year)
  if (day) return `${day}T12:00:00${offset}`
  const datetime = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})([.,]\d{1,6})?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/u.exec(text)
  if (!datetime) throw new MindNoteContentError('captured_at 必须是日期或带时区的 ISO 8601 时间')
  if (!datetime[5]) throw new MindNoteContentError('captured_at 日期时间必须带时区')
  let canonical: string
  try {
    canonical = utc(`${datetime[1]}T${datetime[2]}:${datetime[3] ?? '00'}${datetime[4]?.replace(',', '.') ?? ''}${datetime[5]}`).replace(' ', 'T')
  } catch {
    throw new MindNoteContentError('captured_at 必须是日期或带时区的 ISO 8601 时间')
  }
  const instant = (value: string) => value.slice(0, 19) + (value.match(/\.\d+/u)?.[0] ?? '.000000')
  if (instant(canonical) > instant(utc(now.toISOString()).replace(' ', 'T')))
    throw new MindNoteContentError('不能创建未来日期的记录')
  return canonical
}

/** 普通笔记写入共用 Mind 事务、版本、Undo、RAG 与调用收据。 */
export function createNoteWritePort(core: SqlDataRuntime, options: {
  timezone: string
  publish(event: { ownerId: string; operation: 'create' | 'update'; note: MindNoteReadResponse; mutationId: string }): Promise<void>
  now?: () => Date
}): NoteWritePort {
  if (!core.receipts) throw new Error('笔记写入收据未装配')
  const clock = () => (options.now?.() ?? new Date()).toISOString()
  const absent = new Error('笔记写入调用收据不存在')
  function key(request: NoteWriteRequest) {
    const context = dataContext(request.identity.ownerId)
    const coordinates = [context.ownerId, request.identity.sessionId, request.identity.runId, request.roundId, request.toolCallId]
    if (coordinates.some(value => !value.trim())) throw new CoreError('invalid_request', '工具运行身份无效')
    const hash = createHash('sha256').update(JSON.stringify(['agent.note.write', ...coordinates])).digest('hex')
    return { context, operationId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}` }
  }
  const method = (request: NoteWriteRequest) => `agent.note.${request.name}`
  async function reconcile(request: NoteWriteRequest): Promise<ToolResult> {
    try {
      const { context, operationId } = key(request)
      const receipt = await core.operationWithTransaction(context, operationId, method(request), request.args, async () => { throw absent })
      return { kind: 'completed', successful: true, mutated: false, value: receipt.result }
    } catch { return { kind: 'unknown' } }
  }

  return { reconcile, async apply(request, signal) {
    signal.throwIfAborted()
    const create = request.name === 'note_create'
    const args = request.args
    if (request.name === 'note_create' && (request.args.markdown === undefined) === (request.args.blocks === undefined)) {
      return failure('请提供 markdown 或 blocks 中的一种。普通笔记优先用 markdown 字符串；需要可点击引用或结构化待办时用 blocks。',
        '普通笔记格式：{"markdown":"# 标题\\n\\n正文"}。不要把数组或对象包装成 item。')
    }
    const mixedBodyUpdate = new MindNoteContentError('正文更新方式只能选一种：append_markdown、append_blocks、line_edits 或 find_replace。普通文字追加优先用 append_markdown。')
    let saved: MindNoteReadResponse | undefined
    let callbackError: unknown
    try {
      const { context, operationId } = key(request)
      const receipt = await core.operationWithTransaction(context, operationId, method(request), args, async tx => {
        try {
          const now = new Date(clock())
          const owner = context.ownerId
          const dbOwner = core.backend === 'sqlite' ? owner.replaceAll('-', '') : owner
          const undo = `agent:${request.identity.sessionId}:${request.identity.runId}`
          const note = (id: number) => tx.selectFrom('mind_nodes').selectAll().where('id', '=', id)
            .where('user_id', '=', dbOwner).where('kind', '=', 'note').where('deleted_at', 'is', null)
          const readBlocks = async (blocks: z.infer<typeof mindBlocksSchema>) => {
            const { markdown, references } = serializeMindBlocks(blocks)
            const tables = { project: 'projects', file: 'files', event: 'calendar_events' } as const
            for (const reference of references) {
              signal.throwIfAborted()
              if (reference.type === 'file' && core.backend === 'sqlite') {
                throw new MindNoteContentError('当前平台未提供笔记文件引用能力')
              }
              // 表名来自固定领域映射，Web 文件元数据表尚未纳入 SQLite Core schema。
              const lock = core.backend === 'postgres' ? sql`FOR SHARE` : sql``
              const { rows: [row] } = await sql`SELECT id FROM ${sql.table(tables[reference.type])}
                WHERE id=${reference.id} AND user_id=${dbOwner} ${lock}`.execute(tx)
              if (!row) throw new MindNoteContentError('引用对象不存在')
            }
            return markdown
          }
          if (request.name === 'note_create') {
            const input = request.args
            if (input.markdown !== undefined && !strip(input.markdown))
              throw new MindNoteContentError('markdown 必须是非空字符串；普通笔记直接传 Markdown 正文。')
            const contentMd = input.markdown ?? await readBlocks(input.blocks!)
            const when = capturedAt(input.captured_at, now, options.timezone)
            const prepared = prepareMindNoteCreate({ title: input.title, color: input.color, contentMd, capturedAt: when }, now)
            if (when && /\.\d{6}/u.test(when)) prepared.preciseCapturedAt = when
            signal.throwIfAborted()
            saved = await createBorrowedSqlMindNoteInserter(tx, core.backend, clock, 'gugu')(owner, prepared, undo)
          } else {
            const input = request.args
            const before = await note(input.node_id).executeTakeFirst()
            if (!before) throw new MindNoteContentError('找不到这条便签')
            const { title, color, captured_at, append_markdown, append_blocks, line_edits, find_replace } = input
            const bodyModeCount = noteBodyModes.filter(mode => input[mode] !== undefined).length
            if (bodyModeCount > 1) throw mixedBodyUpdate
            if (bodyModeCount === 0 && title === undefined && color === undefined && captured_at === undefined)
              throw new MindNoteContentError('至少提供一个要修改的字段')
            const patch: Record<string, unknown> = { version: Number(before.version) }
            if (title !== undefined) patch.title = title
            if (color !== undefined) patch.color = color
            const when = capturedAt(captured_at, now, options.timezone)
            if (when !== undefined) patch.capturedAt = when
            if (append_markdown !== undefined && !strip(append_markdown))
              throw new MindNoteContentError('append_markdown 必须是非空字符串。')
            const appended = append_markdown ?? (append_blocks !== undefined ? await readBlocks(append_blocks) : undefined)
            if (appended === '') throw new MindNoteContentError('append_blocks 不能为空')
            if (appended !== undefined) patch.contentMd = before.content_md ? `${before.content_md}\n\n${appended}` : appended
            if (line_edits !== undefined) patch.contentMd = applyMindLineEdits(before.content_md, line_edits)
            if (find_replace !== undefined) patch.contentMd = replaceUniqueMindText(before.content_md, find_replace.find, find_replace.replace)
            signal.throwIfAborted()
            const prepared = prepareMindNoteUpdate(patch, now)
            if (when && /\.\d{6}/u.test(when)) prepared.preciseCapturedAt = when
            saved = (await createSqlMindNoteMutator(tx, core.backend, clock).update(owner, input.node_id, prepared, undo)).note
          }
          return { note: agentMindNodeDetail(await note(saved.id).executeTakeFirstOrThrow()) }
        } catch (error) {
          callbackError = error
          throw error
        }
      }, { signal })
      if (!receipt.replayed && saved) {
        try { await options.publish({ ownerId: context.ownerId, operation: create ? 'create' : 'update', note: saved, mutationId: operationId }) }
        catch { /* 通知失败不影响已提交的笔记。 */ }
      }
      return { kind: 'completed', successful: true, mutated: !receipt.replayed, value: receipt.result }
    } catch (error) {
      if (signal.aborted && error === callbackError) throw error
      if (error === mixedBodyUpdate)
        return failure(mixedBodyUpdate.message, '普通文字追加格式：{"node_id":123,"append_markdown":"追加内容"}，node_id 必须来自 note_search/note_get。')
      if (error === callbackError && error instanceof MindNoteMutationError && error.statusCode === 409)
        return failure('便签刚被修改，请稍后重试；本次只允许追加或修改指定字段')
      if (error === callbackError && (error instanceof MindNoteContentError || error instanceof MindNoteCreateError || error instanceof MindNoteMutationError))
        return failure(error.message)
      if (error instanceof CoreError && error.code === 'conflict') return failure('操作标识已用于不同内容')
      return reconcile(request)
    }
  } }
}

export function createNoteWriteTools(port: NoteWritePort): ToolDefinition[] {
  const descriptions = {
    note_create: '创建普通时间流笔记。使用 markdown 或 blocks，标题用于索引。captured_at 可指定归属日期。',
    note_update: '更新普通笔记。正文更新方式互斥，一次最多传一个：append_markdown（普通追加）、append_blocks（结构化追加）、line_edits（按行编辑）或 find_replace（原文唯一匹配时替换）。数字行编辑以 note_get.numbered_content 的物理行号为准，标题和空行均计入；expected 只传原文，不含行号前缀。局部替换优先从 note_get.content_md 复制原文到 find_replace.find。',
  }
  const names = ['note_create', 'note_update'] as const
  return names.map(name => {
    const schema = noteWriteSchemas[name]
    const parameters = z.toJSONSchema(schema) as Record<string, Json>
    if (name === 'note_update') parameters.not = { anyOf: mixedNoteBodyModes }
    return {
      definition: { name, schema: { type: 'function', function: {
        name, description: descriptions[name], parameters,
      } } },
      effect: 'write',
      strictArrayFields: ['blocks', 'append_blocks', 'content', 'items', 'paragraphs'],
      validate: input => schema.safeParse(input),
      execute: (args, scope, call) => port.apply({ name, args, identity: scope.identity, roundId: scope.roundId, toolCallId: call.id } as NoteWriteRequest, scope.signal),
      reconcile: (args, identity, call) => port.reconcile({ name, args, identity, roundId: identity.roundId, toolCallId: call.id } as NoteWriteRequest),
    }
  })
}
