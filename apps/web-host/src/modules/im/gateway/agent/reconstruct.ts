import { createAgentRunToolPorts, contextAccessScopeHash, stableJson, type CanonicalContextPorts, type CanonicalRunContext, type ContextSourcePorts, type RunEvent, type RunIdentity } from '@gugu/core/agent'
import type { ProviderContextFactoryInput, ProviderFactoryContext } from '@gugu/core/providers'
import { imActorInputFromPayload, imCanUseTool, imContextPolicy, type ImActor, type ImActorInput } from '@gugu/core/im/access'
import { createImRunDelivery, ImRunDeliveryBlocked, type ImRunDeliveryPorts } from '@gugu/core/im/run-delivery'
import type { AgentDispatchLease, ImAgentDispatchInput } from '../../../agent/run/dispatch.js'
import { agentDispatchSource } from '../../../agent/run/dispatch.js'
import { createPersistentAgentRuntime, createPersistentAgentRuntimeWithContextFactory, type PersistentAgentRuntimeOptions } from '../../../agent/run/runtime.js'
import { AgentDispatchDeferredError } from '@gugu/core/agent'
import { AgentRunReconstructionVersionError as AgentReconstructionVersionError } from '@gugu/core/agent'
import { createWebAgentBindingHistory, type WebAgentBinding, type WebAgentReconstructionResources } from '../../../agent/run/reconstruct.js'
import { createPostgresAgentRunStore } from '../../../agent/run/store.js'
import { createPostgresCurrentTurnReader, createWebAgentSourceLoader } from '../../../agent/context/source.js'
import type { AgentContextBuilderPorts } from '@gugu/core/agent'
import { createImAgentContextBuilder } from './context.js'
import { createPostgresImAccess } from '../inbound/access.js'
import { ImDeliveryStoreError, withPostgresImDeliveryStore, type ImDeliverySession } from '../delivery/store.js'
import { parseImAttentionRecord } from '@gugu/core/im/attention/directive'
import { createImGroupReplyGate } from '../attention/gate.js'
import { createPostgresImAttentionPolicyGuard } from '../attention/policy.js'
import { ImVoiceUnavailableError } from '../inbound/message.js'

type ImLease = AgentDispatchLease & { input: ImAgentDispatchInput }
type Route = { binding: { ownerId: string; botId: string; platform: ImAgentDispatchInput['im']['platform'] }; payload: Record<string, unknown> }
export interface ImAgentReconstructionResources extends Omit<WebAgentReconstructionResources, 'source' | 'mcp' | 'context'> {
  /** 生产工厂绑定真实用量、私有续接提交和成功反思任务同事务登记。 */
  history?: PersistentAgentRuntimeOptions['history']
  context: WebAgentReconstructionResources['context'] | {
    services: ProviderContextFactoryInput['services']
    createContext(runtime: Parameters<ProviderContextFactoryInput['createContext']>[0]): Omit<ProviderFactoryContext, 'load'> | Promise<Omit<ProviderFactoryContext, 'load'>>
  }
  source: Omit<ContextSourcePorts, 'readSnapshot' | 'historyReader' | 'currentTurn' | 'select' | 'digest' | 'nextId' | 'builder'>
  builder: Omit<AgentContextBuilderPorts, 'dynamic'> & { now(): number }
  sender: ImRunDeliveryPorts<CanonicalRunContext>['sender']
  showIntermediateReplies?: boolean
  streamFactory?(receipts: ImDeliverySession, authorize: () => Promise<boolean>): NonNullable<ImRunDeliveryPorts<CanonicalRunContext>['stream']> & { prepare?(events: AsyncIterable<RunEvent>): AsyncIterable<RunEvent>; close?(): Promise<void> }
  /** 平台可观察实际Run生命周期（如微信typing）；每次平台动作仍须调用当前授权。 */
  observeRun?(events: AsyncIterable<RunEvent>, authorize: () => Promise<boolean>): AsyncIterable<RunEvent>
}
export interface ImAgentReconstructorOptions {
  pool: PersistentAgentRuntimeOptions['pool']
  /** 同一数据库的独立连接池；长持投递锁不能耗尽Runner checkpoint所需连接。 */
  deliveryPool: Pick<ImAgentReconstructorOptions['pool'], 'connect'>
  secretKey: string
  redis: PersistentAgentRuntimeOptions['redis']
  subscribe: PersistentAgentRuntimeOptions['subscribe']
  history: PersistentAgentRuntimeOptions['history']
  observation?: PersistentAgentRuntimeOptions['observation']
  log?: PersistentAgentRuntimeOptions['runtime']['log']
  access: ReturnType<typeof createPostgresImAccess>
  readRoute(identity: RunIdentity): Promise<Route | null>
  readReconstructionStatus(identity: RunIdentity): Promise<'unavailable' | 'version_conflict' | null>
  /** 内部延迟ASK须以持久resume收据及取消水位复核；Redis complete不等于取消。 */
  verifyPendingAsk?(identity: RunIdentity, payload: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<'ready' | 'cancelled'>
  /** 基于同一可信actor绑定模型/凭据版本；不可重新挑选恢复运行的模型。 */
  bind(lease: ImLease, actor: ImActor, checkpoint: CanonicalRunContext | null): Promise<WebAgentBinding | null>
  resources(lease: ImLease, binding: WebAgentBinding, actor: ImActor, route: Route, authorizeCurrent: () => Promise<boolean>): Promise<ImAgentReconstructionResources | null>
  /** 固定码；不把正文、工具参数或底层异常交给可见日志。 */
  diagnose(code: 'delivery_pending'): void
}
const sameIdentity = (a: RunIdentity, b: RunIdentity) => a.ownerId === b.ownerId && a.sessionId === b.sessionId && a.runId === b.runId

export function imActorInputForDispatch(lease: Pick<ImLease, 'identity' | 'input'>, route: Route): ImActorInput {
  const { identity, input: { im } } = lease, p = route.payload
  if (im.attention !== undefined || p._node_attention !== undefined) {
    try {
      if (stableJson(parseImAttentionRecord(im.attention)) !== stableJson(parseImAttentionRecord(p._node_attention)))
        throw new Error()
      const messages = Array.isArray(p._batch_messages) ? p._batch_messages : [p]
      if (messages.filter(message => message && typeof message === 'object'
        && (message as Record<string, unknown>)._node_stream_event_id === im.attention!.subjectEventId).length !== 1) throw new Error()
    } catch { throw new AgentReconstructionVersionError('IM 注意力决策不匹配') }
  }
  if (route.binding.ownerId !== identity.ownerId || route.binding.botId !== im.botId || route.binding.platform !== im.platform
    || p.owner_user_id !== identity.ownerId || p.bot_id !== im.botId || p.platform !== im.platform
    || p.platform_user_id !== im.platformUserId || p.chat_type !== im.chatType
    || (im.chatType === 'group' ? p.chat_id !== im.chatId : im.chatId !== null))
    throw new AgentReconstructionVersionError('IM 持久路由身份不匹配')
  const batch = im.batch, facts = p._inbound_batch
  if (batch) {
    if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new AgentReconstructionVersionError('IM 批次路由缺失')
    const metadata = facts as Record<string, unknown>
    if (metadata.batchKey !== batch.batchKey || metadata.segmentKey !== batch.segmentKey
      || !Array.isArray(metadata.messageIds) || metadata.messageIds.length !== batch.messageIds.length
      || metadata.messageIds.some((id, index) => id !== batch.messageIds[index])
      || !Array.isArray(p._batch_messages) || p._batch_messages.length !== batch.messageIds.length)
      throw new AgentReconstructionVersionError('IM 批次路由不匹配')
  } else if (facts !== undefined || p._batch_messages !== undefined) throw new AgentReconstructionVersionError('IM 批次声明缺失')
  // 此输入只来自已解密且验签的收据；所有发言人的权限都重新解析。
  try { return imActorInputFromPayload(route.binding, p) }
  catch { throw new AgentReconstructionVersionError('IM 入站身份事实无效') }
}

/** IM来源单独重建，复用同一持久Runner和Provider，不复用Web空IM记忆特例。 */
export function createImAgentReconstructor(options: ImAgentReconstructorOptions) {
  if (!options.deliveryPool || options.deliveryPool === options.pool) throw new TypeError('IM 投递必须使用独立连接池')
  const store = createPostgresAgentRunStore<CanonicalRunContext>(options.pool, options.secretKey, options.history)
  return async (candidate: AgentDispatchLease) => {
    if (agentDispatchSource(candidate.input) !== 'im' || candidate.input.v !== 3)
      throw new AgentReconstructionVersionError('IM 运行来源无法验证')
    const lease = candidate as ImLease, id = lease.identity
    const route = await options.readRoute(id)
    if (!route) return null
    const input = imActorInputForDispatch(lease, route), access = await options.access.snapshot(input), actor = access.actor(input)
    let policyAllowed:()=>Promise<boolean>
    try{policyAllowed=createPostgresImAttentionPolicyGuard({pool:options.pool,identity:id,input,record:lease.input.im.attention})}
    catch{throw new AgentReconstructionVersionError('IM 自动回复策略范围无效')}
    const authorizeCurrent=async()=>await options.access.authorizeDelivery(actor,access.bot)&&await policyAllowed()
    const authorizeTool=async(target:ImActorInput,name:string,automatic=false)=>await options.access.authorizeTool(target,name,automatic)&&await policyAllowed()
    const requestCancellation=async()=>{
      try{
        const changed=await options.pool.query(`UPDATE agent_run_dispatch SET cancel_requested=true
          WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND state='selected' AND token=$4 AND fence=$5
            AND lease_expires_at>clock_timestamp() RETURNING run_id`,[id.ownerId,id.sessionId,id.runId,lease.token,lease.fence])
        if(changed.rowCount!==1)throw new AgentDispatchDeferredError()
      }catch{throw new AgentDispatchDeferredError()}
    }
    if (route.payload._node_pending_ask_resume_id !== undefined) {
      if (!options.verifyPendingAsk) throw new AgentReconstructionVersionError('IM 延迟回复证明端口缺失')
      const status = await options.verifyPendingAsk(id, route.payload, new AbortController().signal)
      if (status !== 'ready' && status !== 'cancelled') throw new AgentReconstructionVersionError('IM 延迟回复证明无效')
      if (status === 'cancelled') {
        // 继续由同一Harness写取消终态；Worker会在start/resume前重读这条持久取消标记。
        await requestCancellation()
      }
    }
    const groupAutoReply = lease.input.im.attention?.disposition === 'run'
    const subject = groupAutoReply ? (Array.isArray(route.payload._batch_messages) ? route.payload._batch_messages : [route.payload])
      .find(message => (message as Record<string, unknown>)._node_stream_event_id === lease.input.im.attention!.subjectEventId) as Record<string, unknown> : null
    const replyGate = groupAutoReply ? createImGroupReplyGate({ identity: id, input, authorizeTool }) : null
    const anchor = await options.pool.query(`SELECT 1 FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
      WHERE s.user_id=$1 AND s.id=$2 AND m.id=$3 AND m.role='user'`, [id.ownerId, id.sessionId, lease.input.userMessageId])
    if (anchor.rowCount !== 1) throw new Error('IM 运行消息锚点不存在')
    const checkpoint = await store.read(id)
    if ((lease.mode === 'resume') !== Boolean(checkpoint)) throw new Error('IM 运行恢复状态不匹配')
    if(!await policyAllowed())await requestCancellation()
    const binding = await options.bind(lease, actor, checkpoint?.context ?? null)
    if (!binding) return null
    try {
      const selection = binding.selection
      const policy = imContextPolicy(actor, access.bot, selection.contextPolicy.memoryEnabled)
      if (selection.contextScopeKey !== lease.input.accessVersion || selection.groupChat !== (actor.chatType === 'group')
        || selection.contextPolicy.loadOwnerContext !== policy.loadOwnerContext || !selection.modelIdentity
        || lease.input.locale && selection.locale !== lease.input.locale
        || checkpoint?.context && checkpoint.context.modelIdentity !== selection.modelIdentity)
        throw new AgentReconstructionVersionError('IM 运行授权或模型版本不匹配')
      const resources = await options.resources(lease, binding, actor, route, authorizeCurrent)
      if (!resources) { binding.release(); return null }
      if (typeof resources.source.data.loadImMemory !== 'function') throw new Error('IM 记忆数据源未配置')
      const context = resources.context, contextServices = 'services' in context ? context.services : context
      const expected = contextAccessScopeHash(id, selection, contextServices.digest)
      if (checkpoint?.context && checkpoint.context.accessScopeHash !== expected)
        throw new AgentReconstructionVersionError('IM 运行访问范围不匹配')
      const provider = await binding.resolve(id, selection.modelIdentity, new AbortController().signal)
      if (provider.modelIdentity !== selection.modelIdentity || provider.accessScopeHash !== expected)
        throw new AgentReconstructionVersionError('IM Provider 访问范围不匹配')
      const source = createWebAgentSourceLoader(options.pool, {
        ...resources.source, builder: createImAgentContextBuilder(actor, resources.builder),
        digest: contextServices.digest, nextId: contextServices.nextId, select: async target => {
          if (!sameIdentity(target, id) || !await authorizeCurrent()) throw new Error('IM 运行授权已变更')
          return selection
        }, currentTurn: createPostgresCurrentTurnReader(options.pool, String(lease.input.userMessageId), resources.materialize),
      })
      const configured = resources.preparation.configuration
      const load: CanonicalContextPorts['load'] = async (identity, signal) => {
        try { return await source.load(identity, signal) }
        catch (error) {
          if (!(error instanceof ImVoiceUnavailableError)) throw error
          signal?.throwIfAborted()
          if (!await authorizeCurrent()) throw new Error('IM 运行授权已变更')
          return { kind: 'early_exit', reason: 'voice_unsupported', response: {
            text: '抱歉，我现在还不能处理语音 / 音视频消息哦，打字告诉我就行～',
          } }
        }
      }
      const toolPorts = createAgentRunToolPorts({
        identity: id,
        preparation: {
          ...resources.preparation,
          async configuration(target, signal) {
            if (!sameIdentity(target, id) || !await authorizeCurrent()) throw new Error('IM 工具授权已变更')
            const config = await configured(target, signal)
            if (config.identity.ownerId !== id.ownerId || config.identity.subject.kind !== 'session'
              || config.identity.subject.id !== id.sessionId || config.source !== actor.platform || !await authorizeCurrent())
              throw new Error('IM 工具来源不匹配')
            return { ...config, toolNames: [...config.toolNames.filter(name => imCanUseTool(actor, name, groupAutoReply) && name !== 'choose_no_reply'),
              ...(groupAutoReply ? ['choose_no_reply'] : [])] }
          },
        },
        configurationMatches(config) {
          return config.source === actor.platform && config.identity.subject.kind === 'session' && config.identity.subject.id === id.sessionId
        },
        registry: {
          async capabilities(target) {
            if (!sameIdentity(target, id) || !await authorizeCurrent()) throw new Error('IM 工具发现身份不匹配')
            const capabilities = await resources.toolRegistry.capabilities(target)
            if (!await authorizeCurrent()) throw new Error('IM 工具授权已变更')
            return [...capabilities.filter(tool => tool.name !== 'choose_no_reply' && imCanUseTool(actor, tool.name, groupAutoReply)),
              ...(replyGate && await authorizeTool(input, 'choose_no_reply', true) ? [replyGate.definition] : [])]
          },
          tools: {
            plan: resources.toolRegistry.tools.plan,
            async dispatch(call, scope) {
              if (!imCanUseTool(actor, call.name) || !await authorizeTool(input, call.name))
                return { kind: 'completed', value: { error: 'IM 工具权限已变更' }, successful: false, mutated: false, executed: false }
              return resources.toolRegistry.tools.dispatch(call, scope)
            },
            async reconcile(call, target) {
              if (!imCanUseTool(actor, call.name) || !await authorizeTool(input, call.name)) return { kind: 'unknown' }
              return resources.toolRegistry.tools.reconcile(call, target)
            },
          },
        },
      })
      const persistentOptions: Omit<PersistentAgentRuntimeOptions, 'context'> = { pool: options.pool, secretKey: options.secretKey, redis: options.redis, subscribe: options.subscribe,
        history: resources.history ?? createWebAgentBindingHistory(lease, binding),
        runPreparation: toolPorts.preparation, executor: resources.executor, provider: { ...resources.provider, resolve: binding.resolve },
        runtime: { ...resources.runtime, observation: options.observation, log: options.log,
          ...(replyGate ? { replyGate } : {}), tools: toolPorts.tools }, interactionActivation: resources.interactionActivation,
        scheduling: { mode: 'dispatch', readReconstructionStatus: options.readReconstructionStatus,
          leaseFor: target => sameIdentity(target, id) ? lease : null },
      }
      const instance = 'services' in context
        ? await createPersistentAgentRuntimeWithContextFactory({ ...persistentOptions, context: {
          services: context.services,
          async createContext(runtime) {
            const complete = await context.createContext(runtime)
            return { ...complete, preparation: { ...complete.preparation, buildRag: resources.ragContext }, load }
          },
        } })
        : createPersistentAgentRuntime({ ...persistentOptions,
          context: { ...context, preparation: { ...context.preparation, buildRag: resources.ragContext }, load } })
      let closed = false
      return { harness: instance.harness, cancellation: instance.cancellation,
        async consume(events: AsyncIterable<RunEvent>) {
          // 专用PG连接锁包围整个投递；平台未知不会取消已在运行的Agent。
          let started = false
          try { await withPostgresImDeliveryStore(options.deliveryPool, id, async receipts => {
            const authorize = authorizeCurrent
            const projection = resources.streamFactory?.(receipts, authorize)
            const delivery = createImRunDelivery({ runner: instance.harness, events: { readAfter: instance.store.readEventsAfter }, receipts,
              digest: contextServices.digest, authorize: async target => sameIdentity(target, id) && await authorize(), sender: resources.sender,
              stream: projection, showIntermediateReplies: resources.showIntermediateReplies })
            const observed = { async *[Symbol.asyncIterator]() { started = true; yield* events } }
            const deliveryEvents = resources.observeRun
              ? resources.observeRun(observed, authorizeCurrent) : observed
            try { await delivery.consume(id, projection?.prepare?.(deliveryEvents) ?? deliveryEvents) }
            catch (error) {
              if (!(error instanceof ImRunDeliveryBlocked)) throw error
              options.diagnose('delivery_pending')
            } finally { await projection?.close?.() }
          }, { secretKey: options.secretKey, platform: actor.platform === 'wechat' ? undefined : actor.platform, ledger: {
            scope: { ownerId: id.ownerId, botId: actor.botId, platform: actor.platform, chatType: actor.chatType, chatId: actor.chatId },
            recipientSenderId: subject ? String(subject.platform_user_id) : actor.platformUserId,
            sourceAttentionKind: lease.input.im.attention?.sourceAttentionKind ?? null,
            proactive: lease.input.im.attention?.proactive ?? false,
          } }) } catch (error) {
            if (!started && error instanceof ImDeliveryStoreError) throw new AgentDispatchDeferredError()
            throw error
          }
        },
        async close() { if (closed) return; closed = true; try { await instance.close() } finally { binding.release() } },
      }
    } catch (error) { binding.release(); throw error }
  }
}
