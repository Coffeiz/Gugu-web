import { createImSendFileTool } from '@gugu/core/tools'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool } from 'pg'
import type { SqlDataRuntime } from '@gugu/core/data'
import { buildAgentStaticPrompt, createCompactionSummarizer, projectPersistentToolResult, redactToolError, stableJson,
  type CanonicalRunContext, type CanonicalRunPreparationPorts, type RunIdentity, type Json } from '@gugu/core/agent'
import { ProviderError, ProviderStreamSanitizer, adapterFor, capabilitySnapshot, stripThinking, type ProviderWire, type ProviderTransport } from '@gugu/core/providers'
import { createNodeProviderTransportFactory } from '@gugu/core/providers/node'
import { imCanUseTool, imDisplayPolicy, imActorInputFromPayload, type ImActor } from '@gugu/core/im/access'
import type { ImAgentDispatchInput } from '../../agent-sessions/persistence/agent-run-dispatch-postgres.js'
import { createPostgresFileReadOperations } from '../../files/file-reads-postgres.js'
import { createAgentToolRegistry } from '../../agent-sessions/tools/agent-tool-registry.js'
import { agentContextSnapshotPrefix } from '@gugu/core/agent'
import { createRedisAgentCancellationCommands, createRedisEventPublisher } from '../../../adapters/cache/redis-events.js'
import { createLocalImMemorySource } from './memory-source.js'
import { createImMessageMaterializer } from './message-materializer.js'
import { createImContextReferenceCodec } from './context-reference-codec.js'
import { createImAgentContextServices } from './context-services.js'
import { createImProductionSkills } from './production-skills.js'
import { createPostgresImMemorySearch } from './memory-search.js'
import { createPostgresImGroupContextSearch } from './group-context.js'
import { createPostgresImRagContextBuilder } from './rag-context.js'
import { createPostgresImReaction } from './reaction-postgres.js'
import { createImRunSender } from './run-sender.js'
import { createImRunScope } from './run-scope.js'
import type { createImOwnerSessions } from './owner-session.js'
import { createImQuotedVoiceProof } from './voice-quote-proof.js'
import { createPersistentFeishuProjection } from './feishu/persistent.js'
import { createPersistentQqProjection } from './qq/persistent.js'
import { readTrustedQqReplySettings } from './qq/format.js'
import { QqMediaUploadError } from './qq/media-upload.js'
import { createPersistentTelegramProjection } from './telegram-persistent.js'
import { createPostgresImAttentionPolicyGuard } from './attention-policy-postgres.js'
import { imActorInputForDispatch, type ImAgentReconstructionResources, type ImAgentReconstructorOptions } from './agent-reconstructor.js'
import type { createConfiguredImAgentProviderBinding } from './provider-binding.js'
import type { GatewayPlatformSender } from './platform-connections.js'
import type { NodeImBotBinding } from './inbox.js'
import type { createPostgresImControls } from './controls-postgres.js'
import type { createPostgresImAccess } from './access-postgres.js'
import type { ImReflectionService } from './reflection-contracts.js'
import type { ImAttachmentScope } from './attachment-ingress.js'
import { createImFileTools } from './file-tools.js'
import { createImHarnessExecutorPorts } from './executor.js'
import { createCanonicalHistoryWriter } from '../../agent-sessions/persistence/agent-canonical-write-postgres.js'
import { createProviderReasoningPersistence } from '../../agent-sessions/persistence/agent-reasoning-persistence.js'
import type { PoolClient } from 'pg'
import { createImRuntimeBindingStore } from './production-bindings-store.js'
import type { createImVoiceSelection } from './voice-config.js'
import { createImVoiceRuntime } from './voice-runtime.js'
import { createImVideoRuntime } from './video-runtime.js'
import { createImImageProcessor } from './image.js'
import { createImVoiceTranscriptStore } from './voice-transcripts.js'
import type { createImVoiceCache } from './voice-cache.js'
export { createImProductionReflectionBindings, createImProductionHistory } from './production-reflection-bindings.js'

type Route = NonNullable<Awaited<ReturnType<ImAgentReconstructorOptions['readRoute']>>>
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
const same = (a: RunIdentity, b: RunIdentity) => a.ownerId === b.ownerId && a.sessionId === b.sessionId && a.runId === b.runId
const unavailable = () => new Error('IM 生产运行资源不可用')
const transcriptTextFields=new Set(['attach_id','name','ext','mime','kind','transcript','transcript_status','transcript_scope','transcript_origin'])
const transcriptNumberFields=new Set(['file_id','size','size_bytes','duration','img_width','img_height'])
const transcriptBooleanFields=new Set(['qq_face','quoted','upload'])

/** 模型真实HTTP前复核当前权限；协议projection/资源构造仍可供已取消Run安全收尾。 */
export function imProductionProvider(options: Pick<ImProductionResourcesOptions, 'provider' | 'environment' | 'diagnose'>,
  authorize: () => Promise<boolean>): ImAgentReconstructionResources['provider'] {
  const wrap = (transport: ProviderTransport): ProviderTransport => ({ async request(request, signal) {
    signal.throwIfAborted()
    if (!await authorize()) throw new ProviderError('cancelled')
    return transport.request(request, signal)
  }, close: transport.close ? () => transport.close!() : undefined })
  const configured = options.provider ?? {}
  if (configured.transport) return { ...configured, transport: wrap(configured.transport), diagnose: () => options.diagnose('im_provider_failed') }
  if (configured.createTransport) return { ...configured, createTransport: config => {
    const actual = configured.createTransport!(config), guarded = wrap(actual)
    return { ...guarded, close: () => actual.close() }
  }, diagnose: () => options.diagnose('im_provider_failed') }
  const factory = configured.transportFactory ?? createNodeProviderTransportFactory({ environment: () => options.environment })
  return { ...configured, transportFactory: { snapshot(config) {
    const actual = factory.snapshot(config)
    return { networkIdentity: actual.networkIdentity, create() {
      const transport = actual.create(), guarded = wrap(transport)
      return { ...guarded, close: () => transport.close() }
    } }
  } }, diagnose: () => options.diagnose('im_provider_failed') }
}

export interface ImProductionResourcesOptions {
  pool: Pool; core: SqlDataRuntime; secretKey: string; storageRoot: string; promptRoot: string; redisUrl: string
  publicAppUrl: string | null; environment: NodeJS.ProcessEnv
  access: ReturnType<typeof createPostgresImAccess>
  model: Pick<Awaited<ReturnType<typeof createConfiguredImAgentProviderBinding>>, 'accessVersion' | 'bindRun'>
  memoryEnabled(ownerId: string): Promise<boolean>
  voice: ReturnType<typeof createImVoiceSelection>
  voiceCache: Pick<ReturnType<typeof createImVoiceCache>, 'readForRun'>
  ownerSessions: Pick<ReturnType<typeof createImOwnerSessions>, 'tool' | 'touchLocked'>
  sender(binding: NodeImBotBinding): GatewayPlatformSender | null
  controls: Pick<ReturnType<typeof createPostgresImControls>, 'authorizeNativeTarget'>
  nativeInteraction: ImAgentReconstructionResources['sender']['interaction']
  readRoute: ImAgentReconstructorOptions['readRoute']
  reflection: ImReflectionService
  retention:{touchLocked(client:PoolClient,identity:RunIdentity):Promise<void>}
  serverTimezone?: string
  /** 默认真实受控Provider transport；隔离整链路测试仅在这一网络边界替换。 */
  provider?: ImAgentReconstructionResources['provider']
  diagnose(code: 'im_runtime_event_pending' | 'im_compaction_failed' | 'im_provider_failed' | 'im_voice_failed' | 'im_video_failed'): void
}
type DeliveryOptions = Omit<ImProductionResourcesOptions, 'core' | 'reflection' | 'retention' | 'promptRoot' | 'diagnose' | 'voice' | 'voiceCache'> & {diagnose?(code:string):void}
type DeliveryInput = { identity: RunIdentity; input: ImAgentDispatchInput; route: Route; actor: ImActor; authorizeCurrent?: () => Promise<boolean> }
function scopeFor(actor: ImActor): ImAttachmentScope {
  return { ownerId: actor.ownerId, botId: actor.botId, platform: actor.platform, chatType: actor.chatType,
    chatId: actor.chatId, platformUserId: actor.platformUserId }
}
/** 同一真实sender资源供活Run与终态恢复使用；不构造假dispatch lease或启动另一个Harness。 */
export async function createImProductionDelivery(options: DeliveryOptions, input: DeliveryInput) {
  const { identity, route, actor } = input, scope = scopeFor(actor), messageIds = (input.input.im.batch?.messageIds ?? [input.input.userMessageId]).map(String)
  const actorInput = imActorInputForDispatch({ identity, input: input.input }, route)
  const bot = await options.access.readBot(actorInput)
  if (!bot) throw unavailable()
  const policy = createPostgresImAttentionPolicyGuard({ pool: options.pool, identity, input: actorInput, record: input.input.im.attention })
  const currentAuthorization = input.authorizeCurrent ?? (async () => await options.access.authorizeDelivery(actor, bot) && await policy()
    && await options.model.accessVersion(identity, actor, bot, await options.memoryEnabled(identity.ownerId)) === input.input.accessVersion)
  let presentationAllowed=true
  const authorize=async()=>presentationAllowed&&await currentAuthorization()
  const common = { pool: options.pool, secretKey: options.secretKey, storageRoot: options.storageRoot, identity, actor, scope, messageIds,
    payload: route.payload, files: createPostgresFileReadOperations(options.pool, null, options.storageRoot), sender: options.sender, authorize }
  // 取消的Run仍须能创建Harness并提交终态；只有实际需要发送时才读取发送材料。
  let actual: ReturnType<typeof createImRunSender> | undefined
  const get = () => actual ??= createImRunSender({ ...common, controls: options.controls, publicAppUrl: options.publicAppUrl,
    nativeInteraction: options.nativeInteraction })
  const sender: ImAgentReconstructionResources['sender'] = {
    text: async value => (await get()).text(value), artifact: async value => (await get()).artifact(value),
    interaction: async value => (await get()).interaction(value),
  }
  const binding: NodeImBotBinding = { ownerId: actor.ownerId, botId: actor.botId, platform: actor.platform }
  const wire = options.sender(binding)
  if (!wire || wire.platform !== actor.platform) throw unavailable()
  let preferences:unknown={}
  if(wire.platform==='telegram'&&scope.chatType==='c2c'){
    try{
      const row=(await options.pool.query('SELECT data_json FROM user_preferences WHERE user_id=$1',[identity.ownerId])).rows[0]
      preferences=row?.data_json?JSON.parse(row.data_json):{}
    }catch{options.diagnose?.('im_preferences_unavailable')} // Python展示偏好读取失败同样采用all/false，不影响身份权限。
  }
  const display=imDisplayPolicy(actor.platform,scope.chatType,preferences)
  let streamFactory: ImAgentReconstructionResources['streamFactory'] = wire.platform === 'feishu' ? (receipts, current) => {
    if (!wire.client) throw unavailable()
    return createPersistentFeishuProjection({ identity, receiveId: scope.chatId ?? scope.platformUserId,
      policyVersion: digest([input.input.accessVersion, actor.chatType]), receipts, client: wire.client,
      authorize: async () => await authorize() && await current(),
      toolSummary: display.toolDisplay==='all'?{chatType:'p2p',includeDetails:false,sanitize:redactToolError}:undefined,
      acceptedEvidence: { scope, recipient: scope.chatId ?? scope.platformUserId, source: () => createImRunScope(common).read() } })
  } : undefined
  if(wire.platform==='qq'&&scope.chatType==='c2c'){
    const settings=await readTrustedQqReplySettings(options.pool,binding,'c2c')
    const history=(await options.pool.query<{streamed:boolean;plain:boolean}>(`SELECT
      EXISTS(SELECT 1 FROM gugu_im_platform_projection WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND platform='qq') AS streamed,
      EXISTS(SELECT 1 FROM gugu_im_delivery_receipts WHERE user_id=$1 AND session_id=$2 AND run_id=$3
        AND state IN ('accepted','pending','unknown') AND (delivery_key LIKE 'round:%:text' OR delivery_key LIKE 'final:%:text')) AS plain`,
      [identity.ownerId,identity.sessionId,identity.runId])).rows[0]
    if(!history||typeof history.streamed!=='boolean'||typeof history.plain!=='boolean')throw unavailable()
    const streaming=settings.messageFormat==='markdown'&&settings.privateStreaming
    // 同Run已接受/未知正文不能因开关热变更切到另一个发送器；恢复原模式后再接续旧收据。
    presentationAllowed=!(streaming&&history.plain||!streaming&&history.streamed)
    if(!presentationAllowed)options.diagnose?.('im_delivery_policy_changed')
    if(streaming){
      const original=route.payload.platform_message_id??route.payload.message_id
      streamFactory=(receipts,current)=>{
        const target={id:scope.platformUserId,chatType:'c2c' as const,messageFormat:'markdown' as const,...(typeof original==='string'?{messageId:original}:{})}
        const permitted=async()=>{
          try{return await authorize()&&await current()&&stableJson(await readTrustedQqReplySettings(options.pool,binding,'c2c'))===stableJson(settings)}catch{return false}
        }
        return createPersistentQqProjection({identity,receipts,sender:wire.sender,target,
          policyVersion:digest([input.input.accessVersion,settings]),authorize:permitted,
          async sendChart(png){
            if(png.byteLength>3*1024*1024||!Buffer.from(png).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||!await permitted())return{outcome:'rejected',platformMessageIds:[]}
            try{
              const uploaded=await wire.mediaUpload.upload({target:'users',openid:scope.platformUserId,fileType:1,data:png,fileName:'chart.png',authorize:permitted})
              if(typeof uploaded.file_info!=='string'||!uploaded.file_info)return{outcome:'unknown',platformMessageIds:[]}
              return wire.sender.media(target,{fileInfo:uploaded.file_info,image:true},undefined,permitted)
            }catch(error){return{outcome:error instanceof QqMediaUploadError&&error.outcome==='FAILED_CONFIRMED'?'rejected':'unknown',platformMessageIds:[]}}
          },acceptedEvidence:{scope,recipient:scope.platformUserId,source:()=>createImRunScope(common).read()}})
      }
    }
  }
  if(wire.platform==='telegram'&&scope.chatType==='c2c'){
    const original=route.payload.platform_message_id??route.payload.message_id
    streamFactory=(receipts,current)=>createPersistentTelegramProjection({identity,receipts,sender:wire.sender,
      target:{chatId:scope.platformUserId,chatType:'c2c',...(typeof original==='string'?{replyToMessageId:original}:{})},
      policyVersion:digest([input.input.accessVersion,display]),authorize:async()=>await authorize()&&await current(),
      showIntermediateReplies:display.showIntermediateReplies,toolSummary:display.toolDisplay==='all'?{chatType:'p2p',includeDetails:false,sanitize:redactToolError}:undefined,
      acceptedEvidence:{scope,recipient:scope.platformUserId,source:()=>createImRunScope(common).read()}})
  }
  const observeRun: ImAgentReconstructionResources['observeRun'] = wire.platform === 'wechat'
    ? (events, current) => wire.sender.observeRun({ userId: actor.platformUserId, contextToken: String(route.payload.context_token ?? '') }, events,
      async () => await authorize() && await current()) : undefined
  return { sender, streamFactory, observeRun, authorize }
}

/** 从真实PG/本地FS/配置/平台组件装配完整Run；网络替身不能替换来源、授权或Agent循环。 */
export function createImProductionResources(options: ImProductionResourcesOptions): ImAgentReconstructorOptions['resources'] {
  if (!options.secretKey || !options.storageRoot || !options.promptRoot || !options.redisUrl || !options.reflection) throw unavailable()
  const redis = createRedisAgentCancellationCommands(options.redisUrl), publisher = createRedisEventPublisher(options.redisUrl)
  return async (lease, binding, actor, route, currentAuthorization) => {
    const identity = lease.identity, selection = binding.selection, actorInput = imActorInputForDispatch(lease, route), scope = scopeFor(actor)
    await createImRuntimeBindingStore(options.pool, options.secretKey).freeze(identity,
      { modelIdentity: selection.modelIdentity, accessVersion: lease.input.accessVersion, usage: binding.usageConfig })
    const authorizeCurrent = async () => await currentAuthorization()
      && await options.memoryEnabled(identity.ownerId) === selection.contextPolicy.memoryEnabled
    const bot = await options.access.readBot(actorInput)
    if (!bot) throw unavailable()
    const messageIds = (lease.input.im.batch?.messageIds ?? [lease.input.userMessageId]).map(String)
    const tombstoned = async (value: { owner_user_id: string; platform: string; bot_id: string; scope_type: string; scope_id: string }) => {
      const result = await options.pool.query(`SELECT 1 FROM memory_scope_tombstones
        WHERE owner_user_id=$1 AND platform=$2 AND bot_id=$3 AND scope_type=$4 AND scope_id=$5`,
      [value.owner_user_id, value.platform, value.bot_id, value.scope_type, value.scope_id])
      return result.rows.length > 0
    }
    const memory = createLocalImMemorySource({ root: options.storageRoot, identity, actor, isTombstoned: tombstoned,
      async authorize() {
        if (!await options.access.authorizeDelivery(actor, bot)) return null
        const rows = await options.pool.query(`SELECT group_memory_enabled,member_memory_enabled FROM user_bots
          WHERE user_id=$1 AND id=$2 AND platform=$3 AND enabled IS TRUE`, [actor.ownerId, actor.botId, actor.platform])
        const row = rows.rows[0]
        if (!row || typeof row.group_memory_enabled !== 'boolean' || typeof row.member_memory_enabled !== 'boolean') throw unavailable()
        return { ...scope, groupMemoryEnabled: row.group_memory_enabled, memberMemoryEnabled: row.member_memory_enabled }
      } })
    const skills = await createImProductionSkills({ pool: options.pool, identity, actor, loadOwnerContext: selection.contextPolicy.loadOwnerContext,
      authorize: () => options.access.authorizeDelivery(actor, bot) })
    const services = await createImAgentContextServices({ pool: options.pool, storageRoot: options.storageRoot, promptRoot: options.promptRoot,
      identity, actor, selection, redis, serverTimezone: options.serverTimezone ?? 'UTC', now: Date.now,
      authorize: () => options.access.authorizeDelivery(actor, bot), imMemory: memory.loadImMemory,
      platformEnabled: async platform => (await options.pool.query(`SELECT 1 FROM user_bots WHERE user_id=$1 AND platform=$2 AND enabled IS TRUE LIMIT 1`,
        [identity.ownerId, platform])).rows.length > 0,
      skillCatalog: candidate => skills.registry.catalog(candidate), systemInMessages: () => false })
    const timezone = await services.source.data.loadTimezone(identity)
    const formatMessageTime = (timestamp: string | number, zone: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: zone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(timestamp))
    const selectedModel = await binding.resolve(identity, selection.modelIdentity, new AbortController().signal)
    const images=createImImageProcessor(),imageLimits=adapterFor(selectedModel.config).mediaLimits(selectedModel.config)
    const video=createImVideoRuntime({ownerId:identity.ownerId,scopeKey:selectedModel.accessScopeHash,secretKey:options.secretKey,config:selectedModel.config,
      redis,authorize:authorizeCurrent,provider:imProductionProvider(options,authorizeCurrent),diagnose:()=>options.diagnose('im_video_failed')})
    const voice = createImVoiceRuntime({ ownerId: identity.ownerId, voice: options.voice, mainConfig: selectedModel.config,
      authorize: authorizeCurrent, provider: imProductionProvider(options, authorizeCurrent), diagnose: () => options.diagnose('im_voice_failed'),
      reuse: (input, selected, signal) => options.voiceCache.readForRun({ identity, actor, scope, payload: route.payload, messageIds,
        authorize: async currentSignal => { currentSignal?.throwIfAborted(); return authorizeCurrent() } }, input, selected, signal) })
    const transcripts = createImVoiceTranscriptStore({ pool: options.pool, secretKey: options.secretKey, identity, scope,
      actor, messageIds, payload: route.payload, authorize: authorizeCurrent })
    const materializer = createImMessageMaterializer({ pool: options.pool, storageRoot: options.storageRoot, identity, scope, messageIds, timezone,
      formatMessageTime,
      authorize: authorizeCurrent, transcribe: voice.transcribe, ...(voice.nativeAudioSupported ? { nativeAudio: voice.nativeAudio,transcribeNative:voice.transcribeNative } : {}),
      prepareVideo:video.prepare,
      fitImage:(input,signal)=>images.fit(input,imageLimits,signal),
      assertQuotedAudio: createImQuotedVoiceProof({pool:options.pool,secretKey:options.secretKey,
        proof:{identity,actor,scope,payload:route.payload,messageIds,authorize:authorizeCurrent},
        async historicalProof(messageId,attachId,signal) {
          signal?.throwIfAborted()
          if(!await authorizeCurrent())throw unavailable()
          // 旧身份来自同会话真实消息/附件/收据；不能用当前actor拼出一个假的旧单条Run。
          const rows=(await options.pool.query(`SELECT r.run_id FROM chat_attachments a
            JOIN conversation_messages m ON m.id=a.message_id JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=a.user_id
            JOIN gugu_im_inbound_receipts r ON r.user_id=s.user_id AND r.session_id=s.id AND r.message_id=m.id AND r.run_id=m.run_id
            WHERE s.user_id=$1 AND s.id=$2 AND m.id=$3 AND a.attach_id=$4 AND a.state='attached' AND r.state='dispatched'
              AND r.platform=$5 AND r.bot_id=$6 AND r.chat_type=$7`,
          [identity.ownerId,identity.sessionId,messageId,attachId,actor.platform,actor.botId,actor.chatType])).rows
          if(rows.length!==1||typeof rows[0]!.run_id!=='string')throw unavailable()
          const oldIdentity={...identity,runId:rows[0]!.run_id},old=await options.readRoute(oldIdentity)
          if(!old||old.binding.ownerId!==actor.ownerId||old.binding.platform!==actor.platform||old.binding.botId!==actor.botId)throw unavailable()
          const oldInput=imActorInputFromPayload(old.binding,old.payload),oldAccess=await options.access.snapshot(oldInput),oldActor=oldAccess.actor(oldInput)
          const batch=old.payload._inbound_batch as {messageIds?:unknown}|undefined
          const oldIds=Array.isArray(batch?.messageIds)?batch.messageIds.map(String):Array.isArray(old.payload._batch_messages)?null:[messageId]
          if(!oldIds||!oldIds.includes(messageId))throw unavailable()
          return {identity:oldIdentity,actor:oldActor,scope:scopeFor(oldActor),payload:old.payload,messageIds:oldIds,
            async authorize(currentSignal) {currentSignal?.throwIfAborted();return await authorizeCurrent()&&await options.access.authorizeDelivery(oldActor,oldAccess.bot)}}
        }}).assert,
      async persistTranscript(messageId, text, status, signal) {
        const files = await transcripts.save(messageId, text, status, signal)
        if (files) try {
          // 用户频道只传公开卡片；不广播存储key、内部extra、平台token或临时下载材料。
          const publicFiles=files.filter((card):card is Record<string,Json>=>!!card&&typeof card==='object'&&!Array.isArray(card)).map(card=>
            Object.fromEntries(Object.entries(card).filter(([key,value])=>transcriptTextFields.has(key)&&typeof value==='string'
              ||transcriptNumberFields.has(key)&&typeof value==='number'&&Number.isFinite(value)
              ||transcriptBooleanFields.has(key)&&typeof value==='boolean')))
          if(!await publisher.publishResourceChanged({ ownerId: identity.ownerId, resource: 'sessions', operation: 'update', entityId: Number(identity.sessionId),
            payload:{message_update:{message_id:Number(messageId),files:publicFiles}} }))options.diagnose('im_runtime_event_pending')
        }
        catch { options.diagnose('im_runtime_event_pending') }
      } })
    const references = materializer.references(createImContextReferenceCodec({ pool: options.pool, identity, scope, authorize: authorizeCurrent }))
    let registry: ReturnType<typeof createAgentToolRegistry>
    const configuration: CanonicalRunPreparationPorts['configuration'] = async (candidate, signal) => {
      signal.throwIfAborted()
      if (!same(candidate, identity) || !await authorizeCurrent()) throw unavailable()
      return { identity: { ownerId: identity.ownerId, workspaceId: null, subject: { kind: 'session', id: identity.sessionId } },
        source: actor.platform, toolNames: (await registry.capabilities(identity)).map(tool => tool.name) }
    }
    const authorizeTool = async (candidate: RunIdentity, name: string) => same(candidate, identity) && await authorizeCurrent()
      && await options.access.authorizeTool(actorInput, name, lease.input.im.attention?.disposition === 'run')
    const fileTools = createImFileTools({ pool: options.pool, secretKey: options.secretKey, storageRoot: options.storageRoot,
      identity, actor, scope, messageIds, payload: route.payload, sender: options.sender,
      files: createPostgresFileReadOperations(options.pool, null, options.storageRoot),
      authorizeTool: (name, signal) => { signal?.throwIfAborted(); return authorizeTool(identity, name) } })
    registry = createAgentToolRegistry({ core: options.core, authorize: authorizeTool, skills: skills.tools, askUser: { async authorization() { return 'disabled' } }, readFile: fileTools.readFile, sendFile: createImSendFileTool(fileTools.sendFile),
      ...(actor.role === 'owner' && actor.chatType === 'c2c' ? { imOwnerSession: options.ownerSessions.tool({ lease,actor,payload:route.payload,messageIds,authorize:()=>authorizeTool(identity,'bind_web_session') }) } : {}),
      time: { now: () => new Date(), timezone: () => services.source.data.loadTimezone(identity) },
      memorySearch: createPostgresImMemorySearch({ ...options, lease, actor, bot, configuration }),
      ...(actor.chatType === 'group' && actor.platform !== 'wechat' ? { groupContext: createPostgresImGroupContextSearch({ pool: options.pool,
        storageRoot: options.storageRoot, identity, actor, beforeMessageId: lease.input.userMessageId,
        authorize: (id, _actor, signal) => { signal.throwIfAborted(); return authorizeTool(id, 'group_context_search') }, isTombstoned: tombstoned }) } : {}),
      ...(actor.platform === 'feishu' ? { imReaction: { platform: 'feishu' as const, port: createPostgresImReaction({ ...options, lease, actor, bot, configuration }) } } : {}),
    })
    const ragContext = createPostgresImRagContextBuilder({ ...options, lease, actor, bot, selection,
      enabled: () => selection.contextPolicy.memoryEnabled && authorizeCurrent() })
    const delivery = await createImProductionDelivery(options, { identity, input: lease.input, route, actor, authorizeCurrent })
    const executor = createImHarnessExecutorPorts({ pool: options.pool, db: options.core.db, storageRoot: options.storageRoot, identity, actor, authorize: authorizeCurrent })
    const stableStyle = selection.contextPolicy.loadOwnerContext ? await services.source.data.loadStylePreferences(identity) : {}
    const stableSystem = buildAgentStaticPrompt(services.builder.staticPrompt(selection, identity, stableStyle))
    let commitContinuation: ((client: PoolClient, context: CanonicalRunContext) => Promise<void>) | undefined
    let reasoning: ReturnType<typeof createProviderReasoningPersistence> | undefined
    const writeHistory = createCanonicalHistoryWriter(async (candidate, modelIdentity) => {
      if (!same(candidate, identity) || modelIdentity !== selection.modelIdentity) throw unavailable()
      return binding.usageConfig
    }, { async afterSuccess(client,id,history,checkpoint) {
      await options.reflection.historyHook(client,id,history,checkpoint)
      await options.retention.touchLocked(client,id)
      await options.ownerSessions.touchLocked(client,{ownerId:actor.ownerId,botId:actor.botId,platform:actor.platform},route.payload,identity.sessionId)
    }, usageSource: actor.platform, async commitContinuation(client, _id, context) {
      if (!commitContinuation) throw new Error('当前协议的私有续接事务尚不可用')
      await commitContinuation(client, context)
    } })
    return {
      history: { writeHistory, async persistPrivateContext(client, id, next, previous) {
        if (reasoning) await reasoning.checkpointHook(client, id, next, previous)
        else if (next.context?.continuationRef) throw unavailable()
      } },
      source: services.source, builder: services.builder, materialize: materializer.materialize, toolRegistry: registry, ragContext, executor,
      ...delivery,
      preparation: { configuration, capabilities: {
        workspaceSupported: false,
        filterConfigured: async (names, _subject, signal) => { signal?.throwIfAborted(); const enabled = new Set((await registry.capabilities(identity)).map(tool => tool.name)); return names.filter(name => enabled.has(name) || name === 'choose_no_reply') },
        // 当前注册器没有Shell；不能因执行后端存在就向模型开放Schema或伪造授权说明。
        shellPolicy: async () => ({ allowed: (await registry.capabilities(identity)).some(tool => tool.name === 'shell'), needsConfirmation: true }),
        shellState: async () => { throw new Error('IM Shell 工具尚未注册') }, appendShellProtocol: () => { throw new Error('IM Shell 工具尚未注册') },
        catalog: skills.catalog,
      }, formatPrefix: ({ snapshot }) => agentContextSnapshotPrefix(snapshot) },
      context: { services: { digest, nextId: randomUUID, references, prepareRequest: services.prepareRequest }, async createContext(provider) {
        const selected = selectedModel
        const policy = adapterFor(selected.config), protocol = policy.protocol(selected.config)
        const frozen = { identity: { ownerId: identity.ownerId, sessionId: identity.sessionId, provider: policy.name,
          // modelIdentity含Run与随机nonce；跨Run状态必须绑定可信配置/凭据/权限版本的稳定scope。
          apiFormat: protocol, model: selected.config.model, configDigest: digest(selection.contextScopeKey),
          reasoningConfigDigest: digest([selected.config.thinking ?? null, selected.config.reasoning_effort ?? null, selected.config.reasoning_persistence]) },
          runId: identity.runId, modelIdentity: selection.modelIdentity, accessScopeHash: selected.accessScopeHash, expectedVersion: 0 }
        reasoning = createProviderReasoningPersistence({ pool: options.pool, secretKey: options.secretKey, provider, binding: frozen,
          mode: selected.config.reasoning_persistence === 'continuation' ? 'continuation' : 'off',
          authorize: async signal => { signal?.throwIfAborted(); return authorizeCurrent() } })
        commitContinuation = (client, context) => reasoning!.commitSuccess(client, context)
        const projection = await provider.summaryProjection(identity, selection.modelIdentity)
        return { digest, nextId: randomUUID, references, prepareRequest: services.prepareRequest,
          ...(reasoning ? { initializeContinuation: reasoning.initialize } : {}),
          preparation: { buildRag: ragContext, formatMessageTime },
          compaction: createCompactionSummarizer<ProviderWire>({ ...identity, stableSystem, tools: [], contextTokens: selection.contextWindow,
            maxOutputTokens: 2000, instruction: services.compactionInstruction }, { digest, nextId: randomUUID, ...projection,
            provider: provider.branchProvider(selection.modelIdentity), pauseBeforeRetry: async (_attempt, signal) => { await delay(250, undefined, { signal }) },
            diagnostic: () => options.diagnose('im_compaction_failed') }),
          finalization: await options.reflection.createFinalizer({ identity, modelIdentity: selection.modelIdentity, provider }),
          diagnoseCompactionFailure: () => options.diagnose('im_compaction_failed'),
        }
      } },
      runtime: { clock: { now: () => new Date().toISOString() }, sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(),
        presentError: () => ({ code: 'im_run_failed', text: '本次处理未完成，请稍后重试。' }), presentToolResult: async value => projectPersistentToolResult(value),
        async publish(event) { if (['final', 'interaction_required', 'run_resumed'].includes(event.type)) {
          try { await publisher.publishResourceChanged({ ownerId: identity.ownerId, resource: 'sessions', operation: 'refresh', entityId: identity.sessionId }) }
          catch { options.diagnose('im_runtime_event_pending') }
        } }, diagnose: () => options.diagnose('im_provider_failed'),
      },
      provider: { ...imProductionProvider(options, authorizeCurrent), async ensureContinuation(context, signal) {
        if (!reasoning) throw unavailable()
        await reasoning.ensure(context, signal)
      }, async invalidateContinuation(context, signal) {
        if (!reasoning) throw unavailable()
        await reasoning.invalidate(context, signal)
      } },
      interactionActivation: { async describe(_client, _id, request) {
        if (request.kind !== 'question' || request.toolCall.name !== 'ask_user' || !await authorizeTool(identity, 'ask_user')) throw unavailable()
        const args = request.toolCall.input as { kind: string; title: string; body: string; options?: Array<{ id: string; label: string }> }
        if (!['question', 'choice'].includes(args.kind)) throw unavailable()
        return { kind: args.kind as 'question' | 'choice', title: args.title, body: args.body, allowTextInput: true,
          options: (args.options ?? []).map(option => ({ ...option, actionType: 'choice' })), context: {} }
      } },
    }
  }
}
