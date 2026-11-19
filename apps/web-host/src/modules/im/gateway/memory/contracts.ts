import type { Pool, PoolClient } from 'pg'
import type { CanonicalCompletionInput, CanonicalFinalizationPort, CanonicalRunContext, ReflectionSnapshot, RunCheckpoint, RunIdentity } from '@gugu/core/agent'
import type { ProviderRuntime, ProviderWire } from '@gugu/core/providers'
import type { ImActor } from '@gugu/core/im/access'
import type { AgentRunHistoryWrite } from '../../../agent/run/store.js'
import type { ImAgentReconstructorOptions } from '../agent/reconstruct.js'
import type { AgentUsageConfig } from '../../../agent/run/usage.js'

export type ImReflectionScope = { type:'owner'|'group'|'platform-user'; id:string }
/** 不含wire/凭据。来源来自成功history事务中的真实v3调度与密封入站收据。 */
export interface ImReflectionJob {
  id:string
  identity:RunIdentity
  actor:ImActor
  scope:ImReflectionScope
  messageIds:readonly string[]
  modelIdentity:string
  accessScopeHash:string
  contextWindow:number
  ownerMessage:string
  assistantEvidence:string
  hadTools:boolean
}
export interface ImReflectionRuntime {
  /** 每次worker独立绑定；不能返回已关闭的主Run ProviderRuntime。 */
  provider:ProviderRuntime
  selection:{modelIdentity:string;accessScopeHash:string;contextWindow:number}
  usageConfig:AgentUsageConfig
  /** 已验证owner维护的词法历史事件参考；不借用已结束Run的活动工具租约。 */
  readOwnerDailyReferences?(query:string,signal:AbortSignal):Promise<readonly unknown[]>
  release():void|Promise<void>
}
export interface ImReflectionServiceOptions {
  pool:Pick<Pool,'query'|'connect'>
  secretKey:string
  storageRoot:string
  supportedPlatforms():readonly string[]|Promise<readonly string[]>
  readRoute:ImAgentReconstructorOptions['readRoute']
  /** historyHook已持会话行锁；必须借用此client，禁止另取连接等待自己。 */
  readRouteLocked(client:PoolClient,identity:RunIdentity):ReturnType<ImAgentReconstructorOptions['readRoute']>
  /** 同生产配置源；不是在模型或入站载荷中声明。 */
  memoryEnabled(identity:RunIdentity):Promise<boolean>
  /** 被动消息还没有Run；读取同一真实配置，不构造虚构Run身份。缺端口时不观察被动消息。 */
  passiveMemoryEnabled?():Promise<boolean>
  /** 群daily独立维护使用现有正式提示词；未装配端口时不创建维护任务。 */
  readGroupCompactionPrompt?():Promise<string>
  readOwnerCompactionPrompt?():Promise<string>
  /** profile/pattern低频维护的正式提示词；只由活跃owner反思登记。 */
  readOwnerPeriodicPrompt?(field:'profile'|'pattern'):Promise<string>
  /** 文件与任务提交后沿既有业务revision通知；失败不能回滚已成功的数据。 */
  memoryChanged?(ownerId:string):Promise<void>
  resolveRuntime(job:Readonly<ImReflectionJob>,signal:AbortSignal,authorizeCurrent:()=>Promise<boolean>):Promise<ImReflectionRuntime>
  /** Core只允许owner idle已授权重建；群无活快照始终defer。须返回同model/access的真实完整Provider前缀。 */
  rebuildOwnerSnapshot(job:Readonly<ImReflectionJob>,runtime:ImReflectionRuntime,signal:AbortSignal):Promise<ReflectionSnapshot<ProviderWire>|null>
  /** 成员scope缺少内存快照时，从原成功checkpoint真实重建；群公开scope禁止使用。 */
  rebuildMemberSnapshot?(job:Readonly<ImReflectionJob>,runtime:ImReflectionRuntime,signal:AbortSignal):Promise<ReflectionSnapshot<ProviderWire>|null>
  /** 固定码，禁止异常/正文/路径。 */
  diagnose(code:'reflection_retry'|'reflection_dead'|'reflection_deferred'|'reflection_notification_pending'|'reflection_usage_unknown'):void
  leaseMs?:number
  pollMs?:number
}
export type ImReflectionHistoryHook=(client:PoolClient,identity:RunIdentity,history:AgentRunHistoryWrite<CanonicalRunContext>,checkpoint:RunCheckpoint<CanonicalRunContext>)=>Promise<void>
export interface ImReflectionService {
  historyHook:ImReflectionHistoryHook
  observePassiveLocked(client:PoolClient,ownerId:string,sessionId:number,messageIds:readonly string[]):Promise<void>
  /** 应在同Provider工厂createContext期间构建；快照只留内存，通知只唤醒事务已提交任务。 */
  createFinalizer(input:{identity:RunIdentity;modelIdentity:string;provider:ProviderRuntime}):Promise<CanonicalFinalizationPort>
  runOnce(signal?:AbortSignal):Promise<boolean>
  start():void
  stop():Promise<void>
  /** 先围栏旧任务再调用既有授权本地删除；清除路径不得绕过此owner互斥。 */
  clearOwner(ownerId:string,remove:()=>Promise<unknown>):Promise<void>
}
export type ImReflectionCompletion=CanonicalCompletionInput
