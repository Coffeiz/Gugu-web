import { z } from 'zod'
import { dataContext, type ProjectRecord, type Stage, type Json } from '../../contracts/index.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import { PROJECT_COLOR_KEYS, projectColorKey } from '../../projects/colors.js'
import type { RunIdentity } from '../models.js'
import type { ToolDefinition } from './contracts.js'
import { resolveProject, type ProjectSelector } from './projects/selector.js'
import { length } from '../../shared/values.js'
import { redactToolError } from '../core.js'
import { enrichToolError } from './input-errors.js'
import type { ProjectStageOperation } from '../../projects/stages.js'

const listInput = z.object({
  status: z.enum(['pending', 'active', 'done']).optional(),
  archived: z.boolean().optional(),
}).passthrough()

/** 项目查询复用 owner-scoped 数据服务，仅转换 Agent 业务投影。 */
export function createListProjectsTool(core: SqlDataRuntime): ToolDefinition {
  return {
    definition: { name: 'list_projects', schema: { type: 'function', function: {
      name: 'list_projects', description: '查询项目；支持按状态和归档状态筛选。',
      parameters: { type: 'object', properties: {
        status: { type: 'string', enum: ['pending', 'active', 'done'] },
        archived: { type: 'boolean' },
      } },
    } } },
    effect: 'read',
    validate(input) {
      const parsed = listInput.safeParse(input)
      return parsed.success ? { success: true, data: parsed.data } : { success: false }
    },
    async execute(input, scope) {
      const args = input as z.infer<typeof listInput>
      const projects = await core.transaction(dataContext(scope.identity.ownerId),
        data => data.projects.list(args.archived ?? false), { signal: scope.signal })
      // Core codec 已将时间规范化为 UTC 并保留微秒；字符串排序不受本机时区或毫秒截断影响。
      // Python Agent 按更新时间降序；通用 Core 列表的创建时间排序不属于工具契约。
      const selected = projects.filter(project => !args.status || project.status === args.status)
        .sort((a, b) => a.updated_at === b.updated_at ? 0 : a.updated_at < b.updated_at ? 1 : -1)
      const value = selected.map(project => {
        const stages = projectStages(project)
        return {
          id: project.id, name: project.name, status: project.status,
          color: projectColorKey(project.color), deadline: project.deadline,
          start_date: project.start_date, client: project.client,
          stages_done: stages.filter(stage => stage.done).length, stages_total: stages.length,
        }
      })
      return { kind: 'completed', successful: true, mutated: false, value }
    },
  }
}


function projectStages(project: ProjectRecord): Stage[] {
  // 与 Python Project.stages 一致：非法 JSON 是空列表；合法但结构错误的值仍失败。
  try { return JSON.parse(project.stages_json) as Stage[] }
  catch (error) { if (error instanceof SyntaxError) return []; throw error }
}

export interface ProjectFileOverview {
  total_file_count: number
  root_file_count: number
  total_folder_count: number
}

const getInput = z.object({ project_id: z.number().int().safe().optional(), project: z.string().optional() }).passthrough()
const overviewInput = z.object({
  total_file_count: z.number().int().nonnegative().safe(),
  root_file_count: z.number().int().nonnegative().safe(),
  total_folder_count: z.number().int().nonnegative().safe(),
}).strict().refine(value => value.root_file_count <= value.total_file_count)

/** Host 必须提供可信 owner-scoped 实时文件概览；缺能力时不构造或开放此工具。 */
export function createGetProjectTool(options: {
  core: SqlDataRuntime
  fileOverview(identity: RunIdentity, projectId: number, signal: AbortSignal): Promise<ProjectFileOverview>
}): ToolDefinition {
  if (typeof options.fileOverview !== 'function') throw new Error('项目文件概览能力未装配')
  return {
    definition: { name: 'get_project', schema: { type: 'function', function: {
      name: 'get_project', description: '读取项目结构。', parameters: { type: 'object', properties: {
        project_id: { type: 'integer' }, project: { type: 'string' },
      }, required: [] },
    } } },
    effect: 'read',
    validate(input) {
      const parsed = getInput.safeParse(input)
      return parsed.success ? { success: true, data: parsed.data } : { success: false }
    },
    async execute(input, scope) {
      const project = await options.core.transaction(dataContext(scope.identity.ownerId),
        data => resolveProject(data, input as z.infer<typeof getInput>), { signal: scope.signal })
      if ('error' in project) return { kind: 'completed', successful: false, mutated: false, value: project }
      scope.signal.throwIfAborted()
      const files = overviewInput.parse(await options.fileOverview(scope.identity, project.id, scope.signal))
      const stages = projectStages(project)
      return { kind: 'completed', successful: true, mutated: false, value: {
        id: project.id, name: project.name, status: project.status, priority: project.priority,
        summary: project.summary, files, client: project.client, start_date: project.start_date,
        deadline: project.deadline, color: projectColorKey(project.color), current_stage: project.current_stage,
        archived: project.archived, stages: stages.map(stage => ({
          key: stage.key ?? null, label: stage.label ?? null, done: stage.done === undefined ? false : stage.done,
          todos: (stage.todos === undefined ? [] : stage.todos).map(todo => ({ id: todo.id ?? null, text: todo.text ?? null, done: todo.done === undefined ? false : todo.done })),
        })),
      } }
    },
  }
}

const projectInput = z.object({
  project_name: z.string(), start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  client: z.string().optional(), summary: z.string().refine(value => length(value) <= 200).meta({ maxLength: 200 }).nullable().optional(),
  status: z.enum(['pending', 'active', 'done']).optional(), priority: z.enum(['high', 'medium', 'low']).optional(),
  color: z.enum(['amber', 'sage', 'teal', 'sky', 'indigo', 'lavender', 'rose', 'sunset']).optional(),
  stages: z.array(z.union([z.string().min(1), z.object({ label: z.string().min(1), todos: z.array(z.string().min(1)).optional() }).strict()])).min(1).optional(),
}).strict()
export type CreateProjectArguments = z.infer<typeof projectInput>
export interface CreateProjectToolResult {
  success: boolean
  project_id?: number
  name?: string
  stages?: string[]
  stage_details?: Array<{ key: string; label: string; todo_count: number }>
  current_stage?: string | null
  idempotent_replay?: boolean
  error?: string
  error_code?: string
  /** 仅供可信工具适配器使用，不写入普通结果。 */
  modelFailure?: 'validation' | 'idempotency_conflict'
}
export interface ProjectCreatePort {
  /** Host 映射平台 session 标识，复用共享创建事务、校验与幂等收据，不公开原始错误。 */
  create(request: { readonly identity: RunIdentity; readonly roundId: string; readonly args: CreateProjectArguments; readonly toolCallId: string; readonly signal: AbortSignal }): Promise<CreateProjectToolResult>
}

/** 只适配工具契约；共享领域创建与真实平台身份解析由可信 Host 注入。 */
export function createProjectTool(port: ProjectCreatePort): ToolDefinition {
  return {
    definition: { name: 'create_project', schema: { type: 'function', function: {
      name: 'create_project', description: '创建项目，填写名称、开始日期、截止日期，可设置颜色、优先级和阶段。',
      parameters: z.toJSONSchema(projectInput) as Record<string, Json>,
    } } },
    effect: 'write',
    validate(input) { return projectInput.safeParse(input) },
    async execute(input, scope, call) {
      if (!call.id) return { kind: 'completed', value: { error: '工具调用标识无效' }, successful: false, mutated: false, executed: false }
      scope.signal.throwIfAborted()
      const result = await port.create({ identity: scope.identity, roundId: scope.roundId, args: input as CreateProjectArguments, toolCallId: call.id, signal: scope.signal })
      const { modelFailure, ...value } = result
      const modelValue = !value.success && modelFailure && typeof value.error === 'string'
        ? enrichToolError('create_project', { error: redactToolError(value.error) }) : undefined
      return { kind: 'completed', value, ...(modelValue === undefined ? {} : { modelValue }), successful: value.success, mutated: value.success && !value.idempotent_replay }
    },
  }
}

export interface AgentProjectChanges {
  name?: string
  status?: 'pending' | 'active' | 'done'
  start_date?: string
  deadline?: string
  client?: string
  summary?: string | null
  priority?: 'high' | 'medium' | 'low' | null
}
export type ProjectMutationIntent =
  | { action: 'update'; selector: ProjectSelector; changes: AgentProjectChanges }
  | { action: 'set_color'; selector: ProjectSelector; color: typeof PROJECT_COLOR_KEYS[number] }
  | { action: 'archive'; selector: ProjectSelector; archived: boolean }
  | { action: 'stages'; selector: ProjectSelector; operation: ProjectStageOperation }

export type ProjectMutationOutcome =
  | { status: 'committed'; mutated: boolean; project: { id: number; name: string; priority: string | null; color: string; archived: boolean }; value?: Record<string,unknown> }
  | { status: 'rejected'; value: { error: string; candidates?: readonly unknown[]; available_projects?: readonly string[]; available?: readonly string[]; results?: readonly Record<string,unknown>[] } }
  | { status: 'unknown' }

/**
 * Host 复用共享项目服务：事务内按 owner 解析目标、读取版本/CAS、处理完成状态待办规则、
 * Undo；目录/存储前缀协调和提交后事件遵守领域生命周期。
 * Host开放时必须使用持久调用收据适配；提交未知仅查收据，缺少证明保留 unknown，不重做业务。
 * 此端口不能由缺少完整副作用的 Core data.projects.update 直接替代。
 */
export interface ProjectMutationRequest {
  identity: RunIdentity
  roundId: string
  toolCallId: string
  signal: AbortSignal
  intent: ProjectMutationIntent
}
export interface ProjectMutationPort {
  apply(input: ProjectMutationRequest): Promise<ProjectMutationOutcome>
  /** 仅查询持久收据，不重新解析或执行目标。 */
  reconcile?(input: Omit<ProjectMutationRequest, 'signal'>): Promise<ProjectMutationOutcome>
}

const selectorFields = { project_id: z.number().int().safe().optional(), project: z.string().optional() }
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const updateInput = z.object({ ...selectorFields,
  status: z.enum(['pending', 'active', 'done']).optional(),
  start_date: date.optional(), deadline: date.optional(), client: z.string().optional(),
  project_name: z.string().optional(), summary: z.string().nullable().optional().refine(value => value == null || [...value].length <= 200),
  priority: z.enum(['high', 'medium', 'low', 'none']).optional(),
}).passthrough()
const colorInput = z.object({ ...selectorFields, color: z.enum(PROJECT_COLOR_KEYS) }).passthrough()
const archiveInput = z.object({ ...selectorFields, archived: z.boolean().optional() }).passthrough()
const schemas = { update_project: updateInput, set_color: colorInput, archive_project: archiveInput }
type MutationName = keyof typeof schemas

function selector(args: ProjectSelector): ProjectSelector {
  return { ...(args.project_id === undefined ? {} : { project_id: args.project_id }),
    ...(args.project === undefined ? {} : { project: args.project }) }
}
function mutationIntent(name: MutationName, input: unknown): ProjectMutationIntent {
  if (name === 'set_color') {
    const args = input as z.infer<typeof colorInput>
    return { action: 'set_color', selector: selector(args), color: args.color }
  }
  if (name === 'archive_project') {
    const args = input as z.infer<typeof archiveInput>
    return { action: 'archive', selector: selector(args), archived: args.archived ?? true }
  }
  const args = input as z.infer<typeof updateInput>
  const changes: AgentProjectChanges = {}
  for (const field of ['status', 'start_date', 'deadline', 'client', 'summary'] as const)
    if (Object.hasOwn(args, field)) Object.assign(changes, { [field]: args[field] })
  if (Object.hasOwn(args, 'project_name')) changes.name = args.project_name
  if (Object.hasOwn(args, 'priority')) changes.priority = args.priority === 'none' ? null : args.priority
  return { action: 'update', selector: selector(args), changes }
}

/** 三个可逆写工具只映射 Agent 意图；没有完整 Host mutation 能力时不构造/开放。 */
export function createProjectMutationTools(port: ProjectMutationPort): ToolDefinition[] {
  if (typeof port?.apply !== 'function') throw new Error('项目修改能力未装配')
  const parameters: Record<MutationName, Record<string, Json>> = {
    update_project: { type: 'object', properties: {
      project_id: { type: 'integer' }, project: { type: 'string' }, project_name: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'active', 'done'] }, start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      deadline: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, client: { type: 'string' },
      summary: { type: ['string', 'null'], maxLength: 200 }, priority: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
    }, required: [] },
    set_color: { type: 'object', properties: { project_id: { type: 'integer' }, project: { type: 'string' }, color: { type: 'string', enum: [...PROJECT_COLOR_KEYS] } }, required: ['color'] },
    archive_project: { type: 'object', properties: { project_id: { type: 'integer' }, project: { type: 'string' }, archived: { type: 'boolean' } }, required: [] },
  }
  const descriptions: Record<MutationName, string> = {
    update_project: '修改项目状态、日期、优先级或项目摘要；优先级传 none 可清除。',
    set_color: '设置项目颜色。', archive_project: '归档或取消归档项目，省略时默认归档。',
  }
  return (Object.keys(schemas) as MutationName[]).map(name => ({
    definition: { name, schema: { type: 'function', function: { name, description: descriptions[name], parameters: parameters[name] } } },
    effect: 'write',
    validate(input) {
      const result = schemas[name].safeParse(input)
      return result.success ? { success: true, data: result.data } : { success: false }
    },
    ...projectMutationHandlers(port,name,input=>mutationIntent(name,input)),
  }))
}

function projectMutationResult(outcome: ProjectMutationOutcome, name: string): import('../models.js').ToolResult {
  if (outcome.status === 'unknown') return { kind: 'unknown' }
  if (outcome.status === 'rejected') return { kind: 'completed', successful: false, mutated: false, value: outcome.value }
  const project = outcome.project
  const value = outcome.value ?? (name === 'update_project' ? { success: true, project_id: project.id, name: project.name, priority: project.priority }
    : name === 'set_color' ? { success: true, project_id: project.id, color: projectColorKey(project.color) }
      : { success: true, project_id: project.id, archived: project.archived })
  return { kind: 'completed', successful: true, mutated: outcome.mutated, value }
}


/** 阶段与待办沿用项目修改的可信调用坐标和同一持久收据执行链。 */
function projectMutationHandlers(port:ProjectMutationPort,name:string,intent:(input:unknown)=>ProjectMutationIntent):Pick<ToolDefinition,'execute'|'reconcile'> {
  return {
    async execute(input,scope,call){
      scope.signal.throwIfAborted()
      if(!scope.identity.ownerId||!scope.identity.sessionId||!scope.identity.runId||!scope.roundId||!call.id)
        return {kind:'completed',successful:false,mutated:false,executed:false,value:{error:'工具运行身份无效'}}
      return projectMutationResult(await port.apply({identity:Object.freeze({...scope.identity}),roundId:scope.roundId,
        toolCallId:call.id,signal:scope.signal,intent:intent(input)}),name)
    },
    async reconcile(input,identity,call){
      if(!port.reconcile)return {kind:'unknown'}
      return projectMutationResult(await port.reconcile({identity,roundId:identity.roundId,toolCallId:call.id,intent:intent(input)}),name)
    },
  }
}

const stageText=z.string().min(1)
const stageEntry=z.object({key:stageText.optional(),label:stageText,todos:z.array(stageText).optional()}).strict()
const stageSchemas={
  add_stage:z.object({...selectorFields,label:stageText,position:z.number().int().safe().min(0).optional()}).strict(),
  remove_stage:z.object({...selectorFields,stage:stageText}).strict(),
  rename_stage:z.object({...selectorFields,stage:stageText,new_label:stageText}).strict(),
  set_stages:z.object({...selectorFields,stages:z.array(z.union([stageText,stageEntry])).min(1)}).strict(),
  update_stage:z.object({...selectorFields,stage:stageText.optional(),add:z.array(stageText).optional(),
    todos:z.array(z.object({text:stageText,stage:stageText.optional(),done:z.boolean().optional(),
      new_text:stageText.optional(),to_stage:stageText.optional(),remove:z.boolean().optional()}).strict()).optional()}).strict(),
}
export function createProjectStageTools(port:ProjectMutationPort):ToolDefinition[]{
  if(typeof port.apply!=='function'||typeof port.reconcile!=='function')throw new Error('阶段修改需要持久调用收据后端')
  const descriptions:Record<keyof typeof stageSchemas,string>={
    add_stage:'给项目新增阶段；position指定插入位置。阶段key为稳定标识。',remove_stage:'按key或唯一名称删除阶段及其待办；至少保留一个阶段，删除当前阶段后切换到剩余首项。',
    rename_stage:'按key或唯一名称重命名阶段；同名阶段必须使用key。',set_stages:'整体声明阶段；省略todos保留原待办，提供todos则重建为未完成；同名阶段须提供key。',
    update_stage:'只传stage切换当前阶段；add新增待办；todos按id、精确文本或唯一模糊文本批量勾选、改名、移动或删除。带add/todos时stage只限定范围；失败项零副作用，成功项一次提交。',
  }
  return (Object.keys(stageSchemas) as (keyof typeof stageSchemas)[]).map(name=>({
    definition:{name,schema:{type:'function',function:{name,description:descriptions[name],parameters:z.toJSONSchema(stageSchemas[name]) as Record<string,Json>}}},
    effect:'write',validate:input=>stageSchemas[name].safeParse(input),
    ...projectMutationHandlers(port,name,input=>{
      const {project_id,project,...args}=input as Record<string,unknown>
      return {action:'stages',selector:selector({project_id:project_id as number|undefined,project:project as string|undefined}),
        operation:{...args,action:name} as ProjectStageOperation}
    }),
  }))
}
