import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProviderRuntime, adapterFor } from '@gugu/core/providers'
import { createAgentRunCodec } from '@gugu/core/agent/run/codec'
import { stableJson, type CanonicalRunContext, type RunIdentity } from '@gugu/core/agent'
import { decryptAgentDispatchInput } from '../../agent-sessions/persistence/agent-run-dispatch-postgres.js'
import { createCanonicalHistoryWriter } from '../../agent-sessions/persistence/agent-canonical-write-postgres.js'
import { imActorInputForDispatch } from './agent-reconstructor.js'
import { createImMessageMaterializer } from './message-materializer.js'
import { createImContextReferenceCodec } from './context-reference-codec.js'
import type { ImProductionResourcesOptions } from './production-resources.js'
import type { ImReflectionRuntime, ImReflectionService, ImReflectionServiceOptions } from './reflection-contracts.js'
import { readImFrozenRequestPrefix } from './context-services.js'
import { imProductionProvider } from './production-resources.js'
import { createImRuntimeBindingStore } from './production-bindings-store.js'
import { createImImageProcessor } from './image.js'
import { createWebOwnerMemorySearchPort } from '../../agent-sessions/tools/agent-memory-search.js'

type Options = Omit<ImProductionResourcesOptions, 'reflection'>
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
const failed = () => new Error('IM 反思模型及历史资源不可用')

async function bindOriginal(options: Options, identity: RunIdentity, modelIdentity: string, scopeHash?: string, signal = new AbortController().signal) {
  const rows = await options.pool.query(`SELECT d.nonce,d.payload,c.version,c.nonce AS checkpoint_nonce,c.payload AS checkpoint_payload
    FROM agent_run_dispatch d JOIN conversation_sessions s ON s.user_id=d.user_id AND s.id=d.session_id
    LEFT JOIN agent_run_checkpoints c ON c.user_id=d.user_id AND c.session_id=d.session_id AND c.run_id=d.run_id
    WHERE d.user_id=$1 AND d.session_id=$2 AND d.run_id=$3`, [identity.ownerId, identity.sessionId, identity.runId])
  const row = rows.rows[0]
  if (rows.rows.length !== 1 || !row) throw failed()
  const input = decryptAgentDispatchInput(options.secretKey, identity, row.nonce, row.payload)
  if (input.v !== 3 || input.source !== 'im') throw failed()
  const route = await options.readRoute(identity)
  if (!route) throw failed()
  const actorInput = imActorInputForDispatch({ identity, input }, route), access = await options.access.snapshot(actorInput), actor = access.actor(actorInput)
  const checkpoint = row.checkpoint_payload ? createAgentRunCodec(options.secretKey).decryptCheckpoint<CanonicalRunContext>(identity,
    Number(row.version), row.checkpoint_nonce, row.checkpoint_payload) : null
  const context = checkpoint?.context
  if (context && context.modelIdentity !== modelIdentity || scopeHash && context?.accessScopeHash !== scopeHash) throw failed()
  const binding = await options.model.bindRun(identity, actor, access.bot, await options.memoryEnabled(identity.ownerId),
    input.locale, scopeHash ? { identity, modelIdentity, accessScopeHash: scopeHash } : context ? { identity, modelIdentity, accessScopeHash: context.accessScopeHash } : undefined, signal)
  if (binding.selection.modelIdentity !== modelIdentity || binding.selection.contextScopeKey !== input.accessVersion) { binding.release(); throw failed() }
  return { binding, actor, input, route, context, checkpoint, bot: access.bot }
}

/** 控制/过期收尾复用初次实际绑定的密封用量配置，不在会话持锁事务里重新选模。 */
export function createImProductionHistory(options: Options, reflection?: ImReflectionService) {
  const bindings = createImRuntimeBindingStore(options.pool, options.secretKey)
  return { writeHistory: createCanonicalHistoryWriter(async (identity, modelIdentity, client) => {
    const original = await bindings.read(identity, client)
    if (original.modelIdentity !== modelIdentity) throw failed()
    return original.usage
  }, { async afterSuccess(client,identity,history,checkpoint) {
    await reflection?.historyHook(client,identity,history,checkpoint)
    await options.retention.touchLocked(client,identity)
  }, async usageSource(identity, client) {
    const row = (await client.query(`SELECT d.nonce,d.payload FROM agent_run_dispatch d
      JOIN conversation_sessions s ON s.user_id=d.user_id AND s.id=d.session_id
      WHERE d.user_id=$1 AND d.session_id=$2 AND d.run_id=$3`, [identity.ownerId, identity.sessionId, identity.runId])).rows[0]
    if (!row) throw failed()
    const input = decryptAgentDispatchInput(options.secretKey, identity, row.nonce, row.payload)
    if (input.v !== 3 || input.source !== 'im') throw failed()
    return input.im.platform
  } }) }
}

/** 反思独立取得Provider生命周期；主Run关闭后不会再复用它的已关闭客户端。 */
export function createImProductionReflectionBindings(options: Options): Pick<ImReflectionServiceOptions, 'resolveRuntime' | 'rebuildOwnerSnapshot' | 'rebuildMemberSnapshot' | 'readGroupCompactionPrompt' | 'readOwnerCompactionPrompt' | 'readOwnerPeriodicPrompt'> {
  const owned = new WeakMap<ImReflectionRuntime, Awaited<ReturnType<typeof bindOriginal>>>()
  return {
    async readGroupCompactionPrompt(){
      const prompt=await readFile(join(options.promptRoot,'im','group_compress.md'),'utf8')
      if(!prompt.trim()||Buffer.byteLength(prompt)>1048576)throw failed()
      return prompt
    },
    async readOwnerCompactionPrompt(){
      const prompt=await readFile(join(options.promptRoot,'memory_compress.md'),'utf8')
      if(!prompt.trim()||Buffer.byteLength(prompt)>1048576)throw failed()
      return prompt
    },
    async readOwnerPeriodicPrompt(field){
      if(field!=='profile'&&field!=='pattern')throw failed()
      const prompt=await readFile(join(options.promptRoot,`${field}_compact.md`),'utf8')
      if(!prompt.trim()||Buffer.byteLength(prompt)>1048576)throw failed()
      return prompt
    },
    async resolveRuntime(job, signal, authorizeCurrent) {
      const original = await bindOriginal(options, job.identity, job.modelIdentity, job.accessScopeHash, signal)
      try {
        if (stableJson(original.actor) !== stableJson(job.actor)) throw failed()
        const { actor, input, bot } = original, identity = job.identity
        const authorize = async () => await options.access.authorizeDelivery(actor, bot)
          && await options.model.accessVersion(identity, actor, bot, await options.memoryEnabled(identity.ownerId)) === input.accessVersion
          && await authorizeCurrent()
        const scope = { ownerId: actor.ownerId, botId: actor.botId, platform: actor.platform, chatType: actor.chatType,
          chatId: actor.chatId, platformUserId: actor.platformUserId }
        const selected=await original.binding.resolve(identity,job.modelIdentity,signal),images=createImImageProcessor()
        const imageLimits=adapterFor(selected.config).mediaLimits(selected.config)
        const materializer = createImMessageMaterializer({ pool: options.pool, storageRoot: options.storageRoot, identity, scope,
          messageIds: (input.im.batch?.messageIds ?? [input.userMessageId]).map(String), timezone: 'UTC',
          formatMessageTime: (value, timezone) => new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(value), authorize,
          fitImage:(input,currentSignal)=>images.fit(input,imageLimits,currentSignal) })
        const references = materializer.references(createImContextReferenceCodec({ pool: options.pool, identity, scope, authorize }))
        const provider = new ProviderRuntime({ ...imProductionProvider(options, authorize), resolve: original.binding.resolve, digest, nextId: randomUUID, references,
          // 该实例只做原wire分支及显式恢复；动态请求尾部不属于反思前缀。
          prepareRequest: async (candidate, _signal, context) => {
            if (candidate.ownerId !== identity.ownerId || candidate.sessionId !== identity.sessionId || candidate.runId !== identity.runId
              || !await authorize()) throw failed()
            if (!context) throw failed()
            return { prefix: await readImFrozenRequestPrefix(options.pool, identity, context), dynamicTail: [] }
          },
          diagnose: () => options.diagnose('im_provider_failed') })
        const result: ImReflectionRuntime = { provider, usageConfig: original.binding.usageConfig,
          selection: { modelIdentity: original.binding.selection.modelIdentity, accessScopeHash: job.accessScopeHash,
            contextWindow: original.binding.selection.contextWindow },
          async release() { try { await provider.close() } finally { original.binding.release() } },
        }
        if(job.scope.type==='owner')result.readOwnerDailyReferences=async(query,currentSignal)=>{
          if((actor.role!=='owner'&&!actor.verifiedOwner)||job.scope.id!==identity.sessionId||!await authorize())throw failed()
          if(!query.trim())return[]
          if(Array.from(query).length>2000)throw failed()
          const sameIdentity=(candidate:RunIdentity)=>candidate.ownerId===identity.ownerId&&candidate.sessionId===identity.sessionId&&candidate.runId===identity.runId
          const search=createWebOwnerMemorySearchPort(options.core,{storageRoot:options.storageRoot,
            authorize:async(candidate,readSignal,scopes)=>!readSignal.aborted&&sameIdentity(candidate)&&!!scopes?.length
              &&scopes.every(scope=>scope.type==='owner'&&scope.ownerId===identity.ownerId&&scope.id===identity.ownerId)&&await authorize(),
            // 独立维护没有主对话快照去重，等价Python memory-compaction；不是Agent Run的空上下文。
            snapshot:async(candidate,readSignal)=>{readSignal.throwIfAborted();if(!sameIdentity(candidate)||!await authorize())throw failed();return{revision:`im-owner-daily:${job.id}`,text:''}},
            resolveScopes:async(candidate,_,readSignal)=>{readSignal.throwIfAborted();if(!sameIdentity(candidate)||!await authorize())throw failed();return[{ownerId:identity.ownerId,type:'owner',id:identity.ownerId}]},
          })
          const found=await search.search(identity,{query,scope:'private_memory',source:'memory',strategy:'bm25',limit:10},currentSignal)
          currentSignal.throwIfAborted();if(!await authorize())throw failed()
          return found&&typeof found==='object'&&!Array.isArray(found)&&Array.isArray(found.results)?found.results:[]
        }
        owned.set(result, original)
        return result
      } catch { original.binding.release(); throw failed() }
    },
    async rebuildOwnerSnapshot(job, runtime, signal) {
      const original = owned.get(runtime)
      if (!original || job.scope.type !== 'owner' || original.actor.role !== 'owner' || original.actor.chatType !== 'c2c'
        || original.checkpoint?.status !== 'completed' || !original.context || !await options.access.authorizeDelivery(original.actor, original.bot)) return null
      const snapshot = await runtime.provider.rebuildReflectionSnapshot(job.identity, original.context, signal)
      if (!await options.access.authorizeDelivery(original.actor, original.bot)) throw failed()
      return snapshot
    },
    async rebuildMemberSnapshot(job,runtime,signal){
      const original=owned.get(runtime)
      if(!original||job.scope.type!=='platform-user'||original.checkpoint?.status!=='completed'||!original.context)return null
      const input=imActorInputForDispatch({identity:job.identity,input:original.input},original.route)
      const prefix=original.actor.chatType==='group'?`${original.actor.chatId}:`:''
      if(prefix&&!job.scope.id.startsWith(prefix))return null
      const speaker=prefix?job.scope.id.slice(prefix.length):job.scope.id
      if(!speaker||!prefix&&speaker!==original.actor.platformUserId)return null
      async function current(){
        signal.throwIfAborted()
        const snapshot=await options.access.snapshot(input)
        if(snapshot.resolve({...input,platformUserId:speaker}).role!=='member'
          ||!await options.access.authorizeDelivery(original!.actor,original!.bot)
          ||await options.model.accessVersion(job.identity,original!.actor,original!.bot,await options.memoryEnabled(job.identity.ownerId))!==original!.input.accessVersion)throw failed()
      }
      await current()
      const snapshot=await runtime.provider.rebuildReflectionSnapshot(job.identity,original.context,signal)
      await current()
      return snapshot
    },
  }
}
