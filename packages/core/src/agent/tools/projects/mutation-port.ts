import { CoreError, dataContext } from '../../../contracts/index.js'
import type { ProjectRecord } from '../../../contracts/index.js'
import { createAgentProjectUpdater } from '../../../projects/project-update.js'
import type { ProjectUpdateMetadata, ProjectUpdateRuntime } from '../../../projects/project-update.js'
import { projectColorValue } from '../../../projects/colors.js'
import type { RunIdentity } from '../../models.js'
import { createHash } from 'node:crypto'
import type { SqlDataRuntime } from '../../../data/runtime.js'
import { services } from '../../../data/repositories.js'
import { nowUtc } from '../../../data/codec.js'
import { applyAgentProjectUpdateInTransaction } from '../../../projects/project-update.js'
import { createKyselyProjectUpdateTransaction } from '../../../projects/update-store.js'
import { prepareProjectStageChange } from '../../../projects/stages.js'
import { projectResponse } from '../../../projects/project-projection.js'
import { projectPersistentToolResult, redactToolError } from '../../core.js'
import { resolveProject } from './selector.js'
import type { ProjectMutationIntent, ProjectMutationOutcome, ProjectMutationPort } from '../projects.js'

type Rejection = Extract<ProjectMutationOutcome, { status: 'rejected' }>['value']
export interface ProjectMutationPortOptions {
  runtime: ProjectUpdateRuntime
  /** 共享服务按可信 owner 定位并返回含版本的快照；不得使用模型指定的 owner。 */
  resolve(identity: RunIdentity, selector: ProjectMutationIntent['selector'], signal: AbortSignal): Promise<ProjectRecord | Rejection>
  metadata?(identity: RunIdentity): ProjectUpdateMetadata
}

/** 薄接线：业务字段校验、完成状态、CAS、目录补偿及事件均由共享应用服务负责。 */
export function createProjectMutationPort(options: ProjectMutationPortOptions): ProjectMutationPort {
  if (typeof options.resolve !== 'function') throw new Error('项目定位能力未装配')
  return { async apply(input) {
    input.signal.throwIfAborted()
    const project = await options.resolve(input.identity, input.intent.selector, input.signal)
    input.signal.throwIfAborted()
    if ('error' in project) return { status: 'rejected', value: project }
    if (!Number.isSafeInteger(project.id) || project.id < 1 || !Number.isSafeInteger(project.version) || project.version < 1)
      throw new Error('项目定位快照无效')
    const intent = input.intent
    if (intent.action === 'stages') return {status:'rejected',value:{error:'阶段修改需要持久调用收据后端'}}
    const fields = intent.action === 'update' ? intent.changes
      : intent.action === 'set_color' ? { color: projectColorValue(intent.color) }
        : { archived: intent.archived }
    if (!Object.keys(fields).length) return { status: 'rejected', value: { error: '未提供可更新的项目内容' } }
    let committed = false
    let transactionStarted = false
    let callbackError: unknown
    const runtime = options.runtime
    const update = createAgentProjectUpdater({
      async transaction(work) {
        transactionStarted = true
        const result = await runtime.transaction(async tx => {
          try {
            input.signal.throwIfAborted()
            const value = await work(tx)
            input.signal.throwIfAborted()
            return value
          } catch (error) { callbackError = error; throw error }
        })
        committed = true
        return result
      },
      renameProjectDirectory: (...args) => runtime.renameProjectDirectory(...args),
      getFileCount: (...args) => runtime.getFileCount(...args),
      publishProjectUpdated: event => runtime.publishProjectUpdated(event),
    })
    const metadata = options.metadata?.(input.identity)
    try {
      // 不让 updater 重新读取后采用更晚的版本覆盖定位之后的其他端修改。
      const result = await update(input.identity.ownerId, project.id, { ...fields, version: project.version }, metadata)
      return { status: 'committed', mutated: true, project: {
        id: result.id as number, name: result.name as string, priority: result.priority as string | null,
        color: result.color as string, archived: result.archived as boolean,
      } }
    } catch (error) {
      // 仅应用层公开领域错误可回传；未知提交状态交由 registry 转 unknown，禁止重放。
      if (!committed && (!transactionStarted || error === callbackError)
        && error instanceof CoreError && ['invalid_request', 'not_found', 'conflict'].includes(error.code))
        return { status: 'rejected', value: { error: error.code === 'conflict' ? '项目刚被其他端修改，请重试' : error.message } }
      throw error
    }
  } }
}

export interface DurableProjectMutationOptions {
  core: SqlDataRuntime
  runtime: Omit<ProjectUpdateRuntime, 'transaction'>
  metadata?(identity: import('../../models.js').RunIdentity): ProjectUpdateMetadata
}
type Input = Parameters<ProjectMutationPort['apply']>[0]
const absentReceipt = new Error('调用收据尚不存在')
function coordinate(input: Omit<Input, 'signal'>) {
  const ownerId = dataContext(input.identity.ownerId).ownerId
  const coordinates = [ownerId,input.identity.sessionId,input.identity.runId,input.roundId,input.toolCallId]
  if (coordinates.some(item => typeof item !== 'string' || !item.trim())) throw new CoreError('invalid_request','工具运行身份无效')
  const hash = createHash('sha256').update(JSON.stringify(coordinates)).digest('hex')
  const hex = hash.slice(0,12)+'5'+hash.slice(13,16)+'8'+hash.slice(17,32)
  return { context: dataContext(ownerId), operationId: `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`,
    method: `agent.project.${input.intent.action}`, params: { intent: input.intent } }
}

/** 持久调用收据先查，事务内重新解析并CAS；恢复仅查询收据，绝不重做业务。 */
export function createDurableProjectMutationPort(options: DurableProjectMutationOptions): ProjectMutationPort {
  const core = options.core
  if (!core.receipts) throw new CoreError('schema_upgrade_required', '项目写工具需要持久调用收据')
  if (['renameProjectDirectory','getFileCount','publishProjectUpdated'].some(name => typeof options.runtime[name as keyof typeof options.runtime] !== 'function')) throw new Error('项目执行后端未装配')
  async function reconcile(input: Omit<Input,'signal'>): Promise<ProjectMutationOutcome> {
    try {
      const key = coordinate(input)
      const stored = await core.operationWithTransaction<ProjectMutationOutcome>(key.context,key.operationId,key.method,key.params,async()=>{throw absentReceipt})
      return stored.result.status === 'committed' ? { ...stored.result, mutated:false } : stored.result
    } catch { return { status:'unknown' } }
  }
  return {
    reconcile,
    async apply(input) {
      input.signal.throwIfAborted()
      let key: ReturnType<typeof coordinate>
      try { key = coordinate(input) } catch { return { status:'rejected',value:{error:'工具运行身份无效'} } }
      const metadata = Object.freeze({ ...options.metadata?.(input.identity) })
      let callbackError: unknown, updated: ProjectRecord | null = null
      const renames: Array<{oldPrefix:string;newPrefix:string}> = []
      try {
        const stored = await core.operationWithTransaction<ProjectMutationOutcome>(key.context,key.operationId,key.method,key.params,async(tx,ownerKey)=>{
          try {
            input.signal.throwIfAborted()
            const project = await resolveProject(services(tx,ownerKey,core.backend,nowUtc),input.intent.selector)
            if ('error' in project) return {status:'rejected',value:project}
            const stageChange=input.intent.action==='stages'?prepareProjectStageChange(project,input.intent.operation):null
            if(stageChange && 'error' in stageChange)return {status:'rejected',value:{...stageChange,...(projectPersistentToolResult(stageChange) as Record<string,unknown>),error:redactToolError(stageChange.error)}}
            const fields = stageChange && 'fields' in stageChange ? stageChange.fields : input.intent.action==='update' ? input.intent.changes : input.intent.action==='set_color'
              ? {color:projectColorValue(input.intent.color)} : {archived:input.intent.action==='archive'?input.intent.archived:false}
            const runtime: ProjectUpdateRuntime = { ...options.runtime, transaction: work=>work(createKyselyProjectUpdateTransaction(tx,core.backend,key.context.ownerId)) }
            const change = await applyAgentProjectUpdateInTransaction(runtime,createKyselyProjectUpdateTransaction(tx,core.backend,key.context.ownerId),key.context.ownerId,
              project.id,{...fields,version:project.version},metadata,
              (oldPrefix,newPrefix)=>renames.push({oldPrefix,newPrefix}))
            updated=change.project
            input.signal.throwIfAborted()
            return {status:'committed',mutated:true,project:{id:updated.id,name:updated.name,priority:updated.priority,color:updated.color,archived:updated.archived},
              ...(stageChange && 'value' in stageChange?{value:projectPersistentToolResult(stageChange.value) as Record<string,unknown>}:{})}
          } catch(error) { callbackError=error; throw error }
        }, {signal:input.signal})
        if (stored.result.status==='committed') {
          if (!stored.replayed && updated) {
            try {
              const project:ProjectRecord=updated
              const payload=projectResponse(project,await options.runtime.getFileCount(key.context.ownerId,project.id))
              await options.runtime.publishProjectUpdated({userId:key.context.ownerId,resource:'projects',origin:metadata.clientId?.trim() || null,operation:'update',entityId:project.id,payload})
            } catch { /* 事务已提交；计数或发布失败不能诱导重做写入。 */ }
          }
          return {...stored.result,mutated:!stored.replayed}
        }
        return stored.result
      } catch(error) {
        // callback之外失败可能是COMMIT结果未知；不能盲目逆向搬目录或重做修改。
        if (error===callbackError) {
          for (const rename of renames.reverse()) {
            try { await options.runtime.renameProjectDirectory(key.context.ownerId,rename.newPrefix,rename.oldPrefix) }
            catch { return {status:'unknown'} }
          }
          if (error instanceof CoreError && ['invalid_request','not_found','conflict'].includes(error.code))
            return {status:'rejected',value:{error:error.code==='conflict'?'项目刚被其他端修改，请重试':redactToolError(error.message)}}
        }
        // 包括收据fingerprint冲突：只返回既有安全领域错误，不猜测异常文字。
        if (error instanceof CoreError && error.code==='conflict' && callbackError===undefined)
          return {status:'rejected',value:{error:'操作标识已用于不同内容'}}
        return reconcile(input)
      }
    },
  }
}
