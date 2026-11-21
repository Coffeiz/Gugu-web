import { createSerialWorker, type SerialWorker } from '../../../workers/admission.js'
import { createMcpManagementTool } from '@gugu/core/tools'
import { createMcpServerConfigLister } from '@gugu/core/mcp/server-list'
import { createMcpSettingsReader } from '../../mcp/status.js'
import { createConfiguredByokEnvelope } from '../../byok/crypto.js'
import { recoverRunModelPin } from '../../agent/llm/recovery.js'
import { createImRuntimeBindingStore } from './agent/store.js'
import { createHash } from 'node:crypto'
import type { Pool,PoolClient } from 'pg'
import type { SqlDataRuntime } from '@gugu/core/data'
import { stripThinking } from '@gugu/core/providers'
import { stableJson, type CanonicalRunContext } from '@gugu/core/agent'
import type {AgentSessionDeletePorts} from '@gugu/core/agent-sessions'
import { imActorInputFromPayload } from '@gugu/core/im/access'
import { createImRunDeliveryRecovery } from '@gugu/core/im/run-delivery'
import { createRedisAgentCancellationCommands, createRedisEventPublisher } from '../../../adapters/cache/redis-events.js'
import { createRedisLiveSubscription } from '../../../adapters/cache/redis-live-subscription.js'
import { createRedisStreamCommands } from '../../../adapters/cache/redis-stream-commands.js'
import { createByokEnvelope, readConfiguredByokMasterKeys } from '../../byok/crypto.js'
import { normalizeOwnerId } from '../../../shared/owner-context.js'
import { createRedisAgentRunCancellationPort } from '../../agent/run/cancel.js'
import { createPostgresAgentRunStore } from '../../agent/run/store.js'
import { createPostgresAgentDispatch } from '../../agent/run/dispatch.js'
import { createAgentDispatchWorker } from '@gugu/core/agent'
import { createFilesystemAuthorizationConfirmationStore } from '../../agent/sandbox/confirmations.js'
import { createImPlatformSettingsReader } from '../settings.js'
import type { createMcpRuntime } from '../../mcp/runtime.js'
import { createImHostLifecycle, acquireImHostOwnership, readImRuntimeOwnership, ImHostAssemblyCleanupError, type ImRuntimeOwnership } from './host-runtime.js'
import { assertImHostSchema, createImRuntimeSettings } from './host-settings.js'
import { createImHostScans } from './host-scans.js'
import { createImInteractionRecovery } from './interactions/recover.js'
import { createGatewayBotConfig, createGatewayConfigChangePublisher, type TrustedGatewayBot } from './bot-config.js'
import { createGatewaySupervisor } from '@gugu/gateway'
import { createPlatformConnections } from './connections.js'
import { createQqSocketFactory } from '@gugu/gateway/qq'
import { createQqMessagePreparer } from './platforms/qq/prepare.js'
import { readTrustedQqMessageFormat } from './reply-settings.js'
import { createFeishuWsNetwork } from '@gugu/gateway/feishu'
import { createPostgresImAttachmentIngress } from './inbound/attachments.js'
import { createPostgresImGatewayAdmission } from './inbound/admission.js'
import { createPostgresImControls } from './attention/controls.js'
import { createPostgresImNativeInteractions } from './interactions/store.js'
import { createPostgresImAccess } from './inbound/access.js'
import { createConfiguredImAgentProviderBinding } from './agent/provider.js'
import { createPostgresImIngress } from './inbound/ingress.js'
import { createImAgentReconstructor, imActorInputForDispatch } from './agent/reconstruct.js'
import { createNodeImWorker } from './worker.js'
import { createRedisImPendingAskStore } from './interactions/ask.js'
import { createPostgresRedisImAttentionSnapshot } from './attention/snapshot.js'
import { createPostgresImAttentionRuntime } from './attention/runtime.js'
import { createPostgresImAcceptedFactsReader } from './attention/ledger.js'
import { withPostgresImDeliveryStore } from './delivery/store.js'
import { createImReflectionService } from './memory/jobs.js'
import { createImVoiceSelection } from './media/config.js'
import { createImOwnerSessions } from './agent/owner.js'
import { createImProductionCompact } from './memory/compact.js'
import { createImDispatchOrder } from './inbound/order.js'
import { createImRetiredInbound } from './inbound/retired.js'
import { createImSessionRetention,ImSessionRetentionError } from './memory/retention.js'
import {createImSessionDelete,ImSessionDeleteUnavailable} from './agent/delete.js'
import { createImHistoryRetention } from './memory/history.js'
import { createPostgresChatAttachmentDraftDeletePorts } from '../../agent/attachments/persistence.js'
import { createImVoiceCache, ImVoiceCacheError } from './media/cache.js'
import { createImAttentionVoiceSource } from './attention/transcript.js'
import { createImVoiceTranscriber } from './media/voice.js'
import { readConfigOverride } from '../../../adapters/config/config-override-file.js'
import type { ImReflectionService } from './memory/contracts.js'
import { createImProductionResources, createImProductionDelivery, createImProductionHistory, createImProductionReflectionBindings, imProductionProvider, type ImProductionResourcesOptions } from './agent/resources.js'
import type { AgentObservationPort, AgentRunLogPort } from '@gugu/core/agent'

export interface NodeImHostOptions {
  pool: Pool; deliveryPool: Pool; core: SqlDataRuntime; secretKey: string; redisUrl: string | null
  configOverridePath: string | null; storageRoot: string; promptRoot: string; publicAppUrl: string | null
  environment: NodeJS.ProcessEnv; ownership?: ImRuntimeOwnership
  /** 与Web API实际消费的同一MCP runtime；不注册尚未装配的MCP工具。 */
  mcpRuntime?: Pick<ReturnType<typeof createMcpRuntime>, 'invalidate'>
    & Partial<Pick<ReturnType<typeof createMcpRuntime>, 'state' | 'testConnection' | 'dispatchForAgent'>>
  mcpDirectory?: NonNullable<ImProductionResourcesOptions['mcpTools']>['directory']
  imOwnerTools?: ImProductionResourcesOptions['imOwnerTools']
  onReflection?(service: ImReflectionService): void
  observation?: AgentObservationPort
  log?: AgentRunLogPort
  runAgent?: SerialWorker
  diagnose(code: string, error?: unknown): void
  /** 隔离整链路测试只替换平台/Provider网络，不替换业务resources、权限或持久化。 */
  testing?: { platform?: Pick<Parameters<typeof createPlatformConnections>[0], 'transport' | 'resolve' | 'qqSocket' | 'feishuNetwork' | 'createFeishuSdk'>
    provider?: ImProductionResourcesOptions['provider']; intervalMs?: number }
}

/** 默认Python归属不构造任何下方服务；Node显式交接后才进入实际生产组件装配。 */
export function createNodeImHostRuntime(options: NodeImHostOptions) {
  const runAgent = options.runAgent ?? createSerialWorker()
  let reflection: ImReflectionService | undefined, lastIssue: string | null = null
  let sessionDelete:ReturnType<typeof createImSessionDelete>|undefined
  const report = (code: string, error?: unknown) => { lastIssue = code; try { options.diagnose(code, error) } catch { /* 诊断不能改变持久消息语义。 */ } }
  const runtime = createImHostLifecycle({ ownership: options.ownership ?? readImRuntimeOwnership(options.environment),
    acquire: () => {
      // 两条常驻PG连接之外，入站事务与Provider配置快照需要独立借用连接。
      if ((options.pool.options.max ?? 10) < 6) throw new Error('Node IM PostgreSQL 连接池容量不足')
      return acquireImHostOwnership(options.pool)
    }, intervalMs: options.testing?.intervalMs, diagnose: report,
    async components() {
      if (!options.redisUrl || !options.configOverridePath || !options.mcpRuntime || options.pool === options.deliveryPool) throw new Error('Node IM 生产依赖尚未配置')
      await assertImHostSchema(options.pool)
      const cleanup: Array<() => void | Promise<void>> = []
      try {
      const environment = options.environment, redisUrl = options.redisUrl, configPath = options.configOverridePath
      const settings = createImRuntimeSettings(configPath, environment), supportedPlatforms = createImPlatformSettingsReader(environment, configPath)
      const gatewayRedis = createRedisStreamCommands(redisUrl), workerRedis = createRedisStreamCommands(redisUrl)
      cleanup.push(() => gatewayRedis.close(), () => workerRedis.close())
      const access = createPostgresImAccess({ query: (q, p) => options.pool.query(q, p), supportedPlatforms })
      const ownerSessions = createImOwnerSessions({ pool: options.pool, secretKey: options.secretKey, supportedPlatforms })
      const retired = createImRetiredInbound({ pool: options.pool, secretKey: options.secretKey })
      const model = await createConfiguredImAgentProviderBinding({ pool: options.pool, configPath, versionSecret: options.secretKey,
        promptRoot: options.promptRoot, environment, permissionIdentity: 'gugu-im-production-tools-v1', defaultLimit6h: settings.defaultLimit6h() })
      const memoryEnabled = async () => settings.memoryEnabled()
      const voice = createImVoiceSelection({ pool: options.pool, document: () => readConfigOverride(configPath), environment,
        async authorize(ownerId) { return (await options.pool.query(`SELECT 1 FROM users WHERE id=$1 AND is_active IS TRUE
          AND COALESCE(account_status,'active')='active'`, [ownerId])).rows.length === 1 } })
      const attachments = createPostgresImAttachmentIngress({ pool: options.pool, storageRoot: options.storageRoot, supportedPlatforms })
      const redis = createRedisAgentCancellationCommands(redisUrl), subscribe = createRedisLiveSubscription(redisUrl)
      const cancellation = createRedisAgentRunCancellationPort(redis, subscribe)
      const publisher = createRedisEventPublisher(redisUrl)
      const publishChanged = createGatewayConfigChangePublisher(options.pool, ownerId => publisher.publishResourceChanged({ ownerId, resource: 'im_channels', operation: 'refresh' }))
      const pendingAsks = createRedisImPendingAskStore({ redis: gatewayRedis, secretKey: options.secretKey })
      const retentionRedis=createRedisStreamCommands(redisUrl,{timeoutMs:1000})
      cleanup.push(()=>retentionRedis.close())
      const retentionPending=createRedisImPendingAskStore({redis:retentionRedis,secretKey:options.secretKey})
      const cleanupAttachments=createPostgresChatAttachmentDraftDeletePorts(options.pool,options.storageRoot,{strictCleanup:true})
      const pendingAskForRetention=async(client:PoolClient,ownerId:string,sessionId:number,signal:AbortSignal):Promise<'clear'|'pending'|'unknown'>=>{
          signal.throwIfAborted()
          const rows=(await client.query('SELECT source,bot_id,chat_id,chat_type FROM conversation_sessions WHERE user_id=$1 AND id=$2',[ownerId,sessionId])).rows
          if(rows.length!==1)return 'unknown'
          const row=rows[0]!
          if(row.chat_type!=='group'&&row.chat_id===null)return 'clear'
          if(row.chat_type!=='group'||!['feishu','qq','telegram'].includes(row.source)||!row.bot_id||!row.chat_id)return 'unknown'
          try{return await retentionPending.hasPending({ownerId,platform:row.source,botId:String(row.bot_id),groupId:String(row.chat_id)},signal)?'pending':'clear'}
          catch{signal.throwIfAborted();return 'unknown'}
        }
      const historyRetention=createImHistoryRetention({pool:options.pool,
        beforeRemoveLocked:(client,ownerId,sessionId,messageIds)=>retired.markLocked(client,ownerId,sessionId,messageIds),
        removeIfUnreferenced:cleanupAttachments.removeUnreferenced,pendingAsk:pendingAskForRetention,diagnose:()=>report('im_retention_failed')})
      cleanup.push(()=>historyRetention.close())
      const sessionRetention=createImSessionRetention({async beforeDeleteLocked(client,ownerId,sessionId){
        if(await pendingAskForRetention(client,ownerId,sessionId,new AbortController().signal)!=='clear')throw new ImSessionRetentionError('busy')
        await retired.markLocked(client,ownerId,sessionId)
      }})
      const snapshot = createPostgresRedisImAttentionSnapshot({ pool: options.pool, redis: gatewayRedis, secretKey: options.secretKey,
        acceptedFacts: createPostgresImAcceptedFactsReader({ pool: options.pool, secretKey: options.secretKey }) })
      const voiceSource = createImAttentionVoiceSource({ pool: options.pool, secretKey: options.secretKey, storageRoot: options.storageRoot, supportedPlatforms })
      const voiceCache = createImVoiceCache({ pool: options.pool, secretKey: options.secretKey, voice,
        async transcribeSelected(source, selected, signal) {
          const authorize = async () => { await source.assertCurrent(signal); return true }
          return createImVoiceTranscriber({ ownerId: source.identity.ownerId, voice, authorize,
            provider: imProductionProvider({ environment, provider: options.testing?.provider, diagnose: report }, authorize),
            diagnose: report }).transcribeSelected(source.input, selected, signal)
        } })
      const attention = createPostgresImAttentionRuntime({ pool: options.pool, snapshot, pending: pendingAsks,
        async prepareVoice(input, signal) {
          const sources = await voiceSource.read(input, signal)
          const results = []
          for (const source of sources) {
            try { results.push(...await voiceCache.prepare([source], signal)) }
            catch (error) {
              signal.throwIfAborted()
              // 已验证来源的可选预转写不可用时仍评分；Run读取同一收据会拒绝未知状态，绝不重新请求ASR。
              if (!(error instanceof ImVoiceCacheError) || error.code === 'unauthorized') throw error
              await source.assertCurrent(signal)
              report('im_voice_failed')
              results.push({ eventId: source.identity.eventId, attachId: source.identity.attachId, text: null })
            }
          }
          return results
        } })
      let controls!: ReturnType<typeof createPostgresImControls>, native!: ReturnType<typeof createPostgresImNativeInteractions>
      let ingress!: ReturnType<typeof createPostgresImIngress>, supervisor!: ReturnType<typeof createGatewaySupervisor<TrustedGatewayBot>>
      const readRoute = (identity: Parameters<typeof ingress.readRoute>[0]) => ingress.readRoute(identity)
      const qq = createQqMessagePreparer({ redis: gatewayRedis, secretKey: options.secretKey,
        authorize: async (scope, signal) => { signal.throwIfAborted(); return !!await access.readBot(scope) }, report: report })
      cleanup.push(() => qq.close())
      const config = createGatewayBotConfig({ pool: options.pool, secretKey: options.secretKey, normalizeOwner: normalizeOwnerId, supportedPlatforms })
      const admission = createPostgresImGatewayAdmission({ pool: options.pool, secretKey: options.secretKey, supportedPlatforms })
      const connections = createPlatformConnections({ redis: gatewayRedis, secretKey: options.secretKey, sanitizeText: stripThinking,
        qqSocket: createQqSocketFactory({ allowDirect: true }), feishuNetwork: () => createFeishuWsNetwork({ allowDirect: true }),
        ...options.testing?.platform, report,
        services: () => ({ controls: controls.ports, admission, attachments, callback: (...args) => native.callback(...args), prepareQq: qq.prepare,
          async qqInstantAckPolicy(scope,payload,signal){
            signal.throwIfAborted()
            const rows=await options.pool.query(`SELECT b.group_requires_at,b.group_read_enabled,b.group_chat_enabled FROM user_bots b JOIN users u ON u.id=b.user_id
              WHERE b.user_id=$1 AND b.id=$2::integer AND b.platform='qq' AND b.enabled IS TRUE
                AND u.is_active IS TRUE AND COALESCE(u.account_status,'active')='active'`,[scope.ownerId,scope.botId])
            if(rows.rows.length!==1)return null
            const row=rows.rows[0]
            if(scope.chatType!=='c2c'&&!(row.group_chat_enabled===true&&row.group_requires_at!==false&&row.group_read_enabled!==true&&payload.group_mentioned===true))return null
            return{messageFormat:await readTrustedQqMessageFormat(options.pool,{platform:'qq',ownerId:scope.ownerId,botId:scope.botId},scope.chatType)}
          },
          async telegramToken(binding, signal) { signal?.throwIfAborted(); return (await config.read()).find(bot => bot.platform === 'telegram' && bot.id === binding.botId && bot.owner === binding.ownerId)?.credentials.appSecret ?? null } }),
      })
      const mcpSettings = createMcpSettingsReader(configPath, environment)
      const { state: readMcpState, testConnection: testMcpConnection } = options.mcpRuntime
      const mcpManagement = readMcpState && testMcpConnection ? {
        enabled: () => mcpSettings().enabled === true,
        tool: createMcpManagementTool({
          list: createMcpServerConfigLister(options.core.db),
          decrypt: createConfiguredByokEnvelope(environment).decrypt,
          enabled: () => mcpSettings().enabled === true,
          state: readMcpState,
          testConnection: testMcpConnection,
        }),
      } : undefined
      const configLister = createMcpServerConfigLister(options.core.db)
      const dispatchMcp = options.mcpRuntime.dispatchForAgent
      const mcpDirectory = options.mcpDirectory
      const mcpTools: ImProductionResourcesOptions['mcpTools'] = dispatchMcp && mcpDirectory ? {
        async directory(owner) {
          if (mcpSettings().enabled !== true) return []
          const configs = await configLister(owner)
          const auto = new Set(configs.filter(config => config.enabled && config.confirm_mode === 'auto').map(config => config.id))
          return auto.size ? (await mcpDirectory(owner)).filter(tool => auto.has(tool.server_id)) : []
        },
        dispatch: dispatchMcp,
      } : undefined
      const production: Omit<ImProductionResourcesOptions, 'reflection'> = {
        pool: options.pool, core: options.core, secretKey: options.secretKey, storageRoot: options.storageRoot, promptRoot: options.promptRoot,
        redisUrl, publicAppUrl: options.publicAppUrl, environment, configOverridePath: configPath, access, model, memoryEnabled, voice, voiceCache, ownerSessions, retention:historyRetention, sender: connections.sender,
        controls: { authorizeNativeTarget: (...args) => controls.authorizeNativeTarget(...args) }, nativeInteraction: input => native.interaction(input),
        readRoute, mcpManagement, mcpTools, imOwnerTools: options.imOwnerTools, diagnose: report, observation: options.observation, ...(options.testing?.provider ? { provider: options.testing.provider } : {}),
      }
      reflection = createImReflectionService({ pool: options.pool, secretKey: options.secretKey, storageRoot: options.storageRoot,
        supportedPlatforms, readRoute, readRouteLocked: (...args) => ingress.readRouteLocked(...args), memoryEnabled,passiveMemoryEnabled:memoryEnabled,
        ...createImProductionReflectionBindings(production),
        async memoryChanged(ownerId){if(!await publisher.bumpContextRevision(ownerId,'memory'))throw new Error('IM记忆版本通知暂不可用')},diagnose: report })
      cleanup.push(() => reflection!.stop())
      options.onReflection?.(reflection)
      const history = createImProductionHistory(production, reflection)
      const compact = createImProductionCompact({ ...production, supportedPlatforms,
        readOwnerSession: (client, scope) => ownerSessions.readLocked(client,
          { ownerId: scope.ownerId, botId: scope.botId, platform: scope.platform },
          { owner_user_id: scope.ownerId, platform: scope.platform, bot_id: scope.botId, chat_type: scope.chatType,
            chat_id: scope.chatId, platform_user_id: scope.platformUserId }) })
      const store = createPostgresAgentRunStore<CanonicalRunContext>(options.pool, options.secretKey, history)
      const confirmation = createFilesystemAuthorizationConfirmationStore({
        async get(key) { const value = await gatewayRedis.sendCommand(['GET', key]); if (value === null || typeof value === 'string') return value; throw new Error('确认状态无效') },
        async del(...keys) { return Number(await gatewayRedis.sendCommand(['DEL', ...keys])) },
        async eval(script, count, ...args) { const value = await gatewayRedis.sendCommand(['EVAL', script, String(count), ...args]); if (value === null || typeof value === 'string') return value; throw new Error('确认状态无效') },
      })
      const keyVersion = Number(environment.CREDENTIALS_MASTER_KEY_VERSION ?? '1')
      async function crypto() {
        const keys = await readConfiguredByokMasterKeys(environment), masterKey = keys[String(keyVersion)]
        if (!Number.isSafeInteger(keyVersion) || keyVersion < 1 || !masterKey) throw new Error('IM 凭据主密钥尚未配置')
        // 显式已有密钥；此分支永不触发createByokEnvelope的文件生成路径。
        return createByokEnvelope({ keyFile: '', version: keyVersion, masterKey, previousKey: keys[String(keyVersion - 1)] })
      }
      controls = createPostgresImControls({ pool: options.pool, redis: gatewayRedis, secretKey: options.secretKey, supportedPlatforms, readRoute, history,
        compact: compact.compact,
        crypto: { async encrypt(values) { return (await crypto()).encrypt(JSON.stringify(values)) }, async decrypt(value) { return (await crypto()).decrypt(value) } },
        async invalidateMcpLocked(client, ownerId, serverId) {
          if ((await client.query('SELECT 1 FROM user_mcp_servers WHERE id=$1 AND user_id=$2 FOR UPDATE', [serverId, ownerId])).rowCount !== 1) throw new Error('MCP 凭据目标不存在')
          await options.mcpRuntime!.invalidate(ownerId, serverId)
        },
        interactionEffects: {
          async applyCommandAction(client, input) {
            if ((await client.query('SELECT 1 FROM conversation_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE', [input.ownerId, input.sessionId])).rowCount !== 1) throw new Error('交互命令来源不存在')
            return { status: 'error', text: '此 IM 命令暂未支持；请在网页中执行。' }
          }, async redeemConfirmation(_client, ownerId, code) { return confirmation.redeem(ownerId, code) },
        }, cancellation, wakeDispatch: () => runtime.wake('dispatch'), wakeInteractions: async () => runtime.wake('interaction'),
        invalidateBinding: () => supervisor.refresh(), publishBindingChanged: publishChanged, diagnose: report,
        async reply(scope, text, reply) {
          reply.signal.throwIfAborted()
          const binding = { ownerId: scope.ownerId, botId: scope.botId, platform: scope.platform }, wire = connections.sender(binding)
          const authorize = async () => !!await access.readBot(scope)
          if (!wire || !await authorize()) throw new Error('IM 控制回复平台不可用')
          let outcome: string
          if (wire.platform === 'telegram') outcome = (await wire.sender.text({ chatId: scope.chatId ?? scope.platformUserId, chatType: scope.chatType }, text, { signal: reply.signal, authorize })).outcome
          else if (wire.platform === 'feishu') outcome = (await wire.sender.text(scope.chatId ?? scope.platformUserId, text, reply.signal, authorize)).outcome
          else if (wire.platform === 'qq') outcome = (await wire.sender.text({ id: scope.chatId ?? scope.platformUserId, chatType: scope.chatType,
            messageFormat: await readTrustedQqMessageFormat(options.pool, binding, scope.chatType) }, text, reply.signal, authorize)).outcome
          else throw new Error('微信控制回复缺少原始上下文；须由协议入站直接回复')
          if (outcome !== 'accepted') throw new Error('IM 控制回复尚未送达')
        },
      })
      native = createPostgresImNativeInteractions({ pool: options.pool, secretKey: options.secretKey, supportedPlatforms, controls, readRoute, sender: connections.sender, diagnose: report })
      const ingressOptions = { pool: options.pool, secretKey: options.secretKey, supportedPlatforms, preflight: controls.preflight, model, memoryEnabled,
        async beforeCreateSession(client:Parameters<typeof sessionRetention.beforeCreate>[0],ownerId:string){
          const result=await sessionRetention.beforeCreate(client,ownerId)
          for(const deleted of result.deleted)await historyRetention.enqueueCleanupLocked(client,ownerId,deleted.storageKeys)
        },
        async conversationChanged(ownerId: string, sessionId: number) {
          await Promise.all([
            publisher.publishResourceChanged({ ownerId, resource: 'sessions', operation: 'update',
              entityId: sessionId, payload: { messages_changed: true } })
              .then(sent => { if (!sent) report('im_runtime_event_pending') }),
            historyRetention.schedule(ownerId, sessionId).then(() => runtime.wake('maintenance')),
          ])
        },
        async observePassiveLocked(client:PoolClient,ownerId:string,sessionId:number,messageIds:readonly string[]){await reflection!.observePassiveLocked(client,ownerId,sessionId,messageIds)},
        attention, pendingAsks, retired, ownerSession: ownerSessions.readLocked, bindVoiceCacheLocked: voiceCache.bindRunLocked, notify: async () => runtime.wake('dispatch'), diagnose: report }
      ingress = createPostgresImIngress({ ...ingressOptions, attachments: { mode: 'text-only' } })
      const scoped = (binding: Parameters<typeof ingress.handle>[0], payload: Record<string, unknown>) => {
        const input = imActorInputFromPayload(binding, payload)
        return createPostgresImIngress({ ...ingressOptions, attachments: attachments.conversation(input) })
      }
      const workerIngress = { handle: (...args: Parameters<typeof ingress.handle>) => scoped(args[0], args[1]).handle(...args),
        prepare: (...args: Parameters<typeof ingress.prepare>) => scoped(args[0], args[1]).prepare(...args),
        prepareAdmitted: (...args: Parameters<typeof ingress.prepareAdmitted>) => scoped(args[0], args[1]).prepareAdmitted(...args),
        handleBatch: (...args: Parameters<typeof ingress.handleBatch>) => { if (!args[1].length) throw new Error('IM 批次为空'); return scoped(args[0], args[1][0]!.payload).handleBatch(...args) } }
      const dispatch = createPostgresAgentDispatch(options.pool, options.secretKey, 30000, ['im'],
        {beforeClaim:createImDispatchOrder({secretKey:options.secretKey,diagnose:report}).beforeClaim})
      const bindingStore = createImRuntimeBindingStore(options.pool, options.secretKey)
      const reconstruct = createImAgentReconstructor({ pool: options.pool, deliveryPool: options.deliveryPool, secretKey: options.secretKey, redis, subscribe,
        access, readRoute, readReconstructionStatus: dispatch.readReconstructionStatus, history, resources: createImProductionResources({ ...production, reflection }),
        verifyPendingAsk: ingress.verifyPendingAskRun, observation: options.observation, log: options.log,
        async bind(lease, actor, checkpoint) {
          const bot = await access.readBot(actor); if (!bot) return null
          const frozen = checkpoint ? null : await bindingStore.readOptional(lease.identity)
          const pin = checkpoint ?? (frozen ? recoverRunModelPin(lease.identity, frozen.modelIdentity, options.secretKey) : null)
          return model.bindRun(lease.identity, actor, bot, await memoryEnabled(), lease.input.locale,
            pin ? { identity: lease.identity, modelIdentity: pin.modelIdentity, accessScopeHash: pin.accessScopeHash } : undefined)
        }, diagnose: report,
      })
      const dispatchWorker = createAgentDispatchWorker({ dispatch, reconstruct, failStart: dispatch.failStart, runExclusive: runAgent })
      const scans = createImHostScans({ pool: options.pool, secretKey: options.secretKey, kick: dispatchWorker.kick, concurrency: 1, diagnose: report,
        async recover(identity, input, signal) {
          const route = await readRoute(identity), actorInput = imActorInputForDispatch({ identity, input }, route), snapshot = await access.snapshot(actorInput), actor = snapshot.actor(actorInput)
          const resources = await createImProductionDelivery(production, { identity, input, route, actor })
          const recipient = input.im.attention ? (Array.isArray(route.payload._batch_messages) ? route.payload._batch_messages : [route.payload])
            .find(message => (message as Record<string, unknown>)._node_stream_event_id === input.im.attention!.subjectEventId) as Record<string, unknown> : null
          await withPostgresImDeliveryStore(options.deliveryPool, identity, async receipts => {
            const projection = resources.streamFactory?.(receipts, resources.authorize)
            try { await createImRunDeliveryRecovery({ events: { readAfter: store.readEventsAfter }, receipts, sender: resources.sender,
              stream: projection, authorize: resources.authorize, showIntermediateReplies: resources.showIntermediateReplies,
              digest: value => createHash('sha256').update(stableJson(value)).digest('hex') }).recover(identity, signal) }
            finally { await projection?.close?.() }
          }, { secretKey: options.secretKey, platform: actor.platform === 'wechat' ? undefined : actor.platform, ledger: { scope: { ownerId: identity.ownerId, platform: input.im.platform, botId: input.im.botId,
            chatType: input.im.chatType, chatId: input.im.chatId }, recipientSenderId: recipient ? String(recipient.platform_user_id) : actor.platformUserId,
            sourceAttentionKind: input.im.attention?.sourceAttentionKind ?? null, proactive: input.im.attention?.proactive ?? false } })
        },
      })
      const interaction = createImInteractionRecovery({ pool: options.pool, secretKey: options.secretKey, dispatch, store, reconstruct, runAgent,
        invalidateCredential: (ownerId, serverId) => options.mcpRuntime!.invalidate(ownerId, serverId) })
      sessionDelete=createImSessionDelete({pool:options.pool,secretKey:options.secretKey,pendingAsks,cancellation,
        wakeDispatch:()=>runtime.wake('dispatch'),wakeInteractions:()=>runtime.wake('interaction'),wakeMaintenance:()=>runtime.wake('maintenance'),diagnose:report})
      const worker = createNodeImWorker({ secretKey: options.secretKey, commands: workerRedis, ingress: workerIngress, concurrency: 1,
        ownership: { runtime: 'node', pythonGatewayStopped: true, pythonImConsumerStopped: true }, diagnose: report })
      supervisor = createGatewaySupervisor({ read: config.read, subscribe: config.subscribe, connect: connections.connect, report })
      return { supervisor, worker, reflection, pauseIngress: connections.pauseIngress,
        async drainRuns() { await Promise.all([dispatchWorker.close(), scans.close(), interaction.close()]) },
        scanDispatch: scans.scanDispatch, recoverDeliveries: scans.recoverDeliveries,
        async maintain(signal:AbortSignal){await historyRetention.scan(signal)},
        pumpPending: signal => ingress.pumpPendingAsks(signal).then(() => undefined), pumpInteractions: interaction.pump,
        async close() {
          const results = await Promise.allSettled([...cleanup].reverse().map(close => Promise.resolve().then(close)))
          if (results.some(result => result.status === 'rejected')) throw new Error('IM 生产资源清理未完成')
        },
      }
      } catch {
        const results = await Promise.allSettled([...cleanup].reverse().map(close => Promise.resolve().then(close)))
        if (results.some(result => result.status === 'rejected')) throw new ImHostAssemblyCleanupError()
        throw new Error('IM 生产资源装配失败')
      }
    },
  })
  return { start: runtime.start, stop: runtime.stop, health: () => ({ ...runtime.health(), lastIssue }),
    async removeSession(ownerId:string,sessionId:number,ports:AgentSessionDeletePorts,legacy:()=>Promise<boolean>):Promise<boolean>{
      if(runtime.health().ownership==='python')return legacy()
      if(runtime.health().status!=='running'||!sessionDelete)throw new ImSessionDeleteUnavailable()
      return sessionDelete.remove(ownerId,sessionId,ports)
    },
    async clearOwner(ownerId: string, remove: () => Promise<unknown>): Promise<void> { if (reflection) await reflection.clearOwner(ownerId, remove); else await remove() } }
}
