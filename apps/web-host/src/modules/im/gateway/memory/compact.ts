import { createHash,randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { buildAgentStaticPrompt,createCompactionSummarizer,stableJson,type Usage } from '@gugu/core/agent'
import { ProviderRuntime } from '@gugu/core/providers'
import { createRedisAgentCancellationCommands } from '../../../../adapters/cache/redis-events.js'
import { recordAgentUsage } from '../../../agent/run/usage.js'
import { createPostgresImCompact } from './store.js'
import { createImAgentContextServices } from '../agent/services.js'
import { createImContextReferenceCodec } from '../agent/references.js'
import { createLocalImMemorySource } from './source.js'
import { createImProductionSkills } from '../agent/skills.js'
import { imProductionProvider,type ImProductionResourcesOptions } from '../agent/resources.js'

const digest=(value:unknown)=>createHash('sha256').update(stableJson(value)).digest('hex')
const unavailable=()=>new Error('IM 会话整理资源暂不可用')
type Options=Pick<ImProductionResourcesOptions,'pool'|'secretKey'|'storageRoot'|'promptRoot'|'model'|'access'|'memoryEnabled'|'redisUrl'|'environment'|'provider'|'serverTimezone'|'diagnose'>
  &Pick<Parameters<typeof createPostgresImCompact>[0],'supportedPlatforms'|'readOwnerSession'>

/** 当前配置独立短命摘要分支；没有Harness/startup，也不依赖过去存在IM Run。 */
export function createImProductionCompact(options:Options){
  return createPostgresImCompact({...options,async runtime({identity,scope,authorize,signal}){
    const actorInput={...scope,botMentioned:false,mentionsOtherBot:false}
    const access=await options.access.snapshot(actorInput),actor=access.actor(actorInput),bot=access.bot
    const memoryEnabled=await options.memoryEnabled(identity.ownerId)
    const binding=await options.model.bindRun(identity,actor,bot,memoryEnabled,'zh-CN',undefined,signal)
    let provider:ProviderRuntime|undefined
    try{
      const selection=binding.selection
      const current=async()=>await authorize()&&await options.access.authorizeDelivery(actor,bot)
        &&await options.model.accessVersion(identity,actor,bot,await options.memoryEnabled(identity.ownerId))===selection.contextScopeKey
      if(!await current())throw unavailable()
      const memory=createLocalImMemorySource({root:options.storageRoot,identity,actor,
        async isTombstoned(value){return (await options.pool.query('SELECT 1 FROM memory_scope_tombstones WHERE owner_user_id=$1 AND platform=$2 AND bot_id=$3 AND scope_type=$4 AND scope_id=$5',[value.owner_user_id,value.platform,value.bot_id,value.scope_type,value.scope_id])).rows.length>0},
        async authorize(){if(!await current())return null;const row=(await options.pool.query('SELECT group_memory_enabled,member_memory_enabled,group_owner_memory_enabled FROM user_bots WHERE user_id=$1 AND id=$2 AND enabled IS TRUE',[actor.ownerId,actor.botId])).rows[0]
          if(!row||typeof row.group_memory_enabled!=='boolean'||typeof row.member_memory_enabled!=='boolean'||typeof row.group_owner_memory_enabled!=='boolean')throw unavailable()
          return {...scope,groupMemoryEnabled:row.group_memory_enabled,memberMemoryEnabled:row.member_memory_enabled,groupOwnerMemoryEnabled:row.group_owner_memory_enabled}}
      })
      const skills=await createImProductionSkills({pool:options.pool,identity,actor,loadOwnerContext:selection.contextPolicy.loadOwnerContext,authorize:current})
      const services=await createImAgentContextServices({pool:options.pool,storageRoot:options.storageRoot,promptRoot:options.promptRoot,
        identity,actor,selection,redis:createRedisAgentCancellationCommands(options.redisUrl),serverTimezone:options.serverTimezone??'UTC',now:Date.now,
        authorize:current,imMemory:memory.loadImMemory,platformEnabled:async platform=>(await options.supportedPlatforms()).includes(platform),
        skillCatalog:candidate=>skills.registry.catalog(candidate),systemInMessages:()=>false,signal})
      const style=selection.contextPolicy.loadOwnerContext?await services.source.data.loadStylePreferences(identity):{}
      const stableSystem=buildAgentStaticPrompt(services.builder.staticPrompt(selection,identity,style))
      provider=new ProviderRuntime({...imProductionProvider(options,current),resolve:binding.resolve,digest,nextId:randomUUID,
        references:createImContextReferenceCodec({pool:options.pool,identity,scope,authorize:current}),prepareRequest:services.prepareRequest})
      const projection=await provider.summaryProjection(identity,selection.modelIdentity,signal)
      const actual=provider.branchProvider(selection.modelIdentity)
      const usage:{-readonly [K in keyof Usage]:Usage[K]}={input:0,output:0,cacheRead:0,cacheWrite:0,contextInput:null}
      const rounds:Record<string,string|number|null>[]=[]
      const compaction=createCompactionSummarizer({ ...identity,stableSystem,tools:[],contextTokens:selection.contextWindow,maxOutputTokens:2000,instruction:services.compactionInstruction },{
        digest,nextId:randomUUID,...projection,provider:{isInputRejected:actual.isInputRejected,async complete(input,requestSignal){
          const result=await actual.complete(input,requestSignal),data=result.usage
          if(data&&typeof data==='object'&&!Array.isArray(data)){
            for(const key of ['input','output','cacheRead','cacheWrite'] as const){const value=Number(data[key]??0);if(!Number.isSafeInteger(value)||value<0)throw unavailable();usage[key]+=value}
            rounds.push({input:Number(data.input??0),output:Number(data.output??0),cache_read:Number(data.cacheRead??0),cache_write:Number(data.cacheWrite??0)})
          }
          if(!await current())throw unavailable()
          return result
        }},pauseBeforeRetry:async(_attempt,s)=>{await delay(250,undefined,{signal:s})},diagnostic:()=>options.diagnose('im_compaction_failed')})
      return {modelIdentity:selection.modelIdentity,timezone:await services.source.data.loadTimezone(identity),compaction,
        async recordUsage(client){await recordAgentUsage(client,identity,usage,binding.usageConfig,rounds,[],{scenario:'compaction',source:scope.platform})},
        async close(){try{await provider!.close()}finally{binding.release()}}}
    }catch{try{await provider?.close()}finally{binding.release()}throw unavailable()}
  }})
}
