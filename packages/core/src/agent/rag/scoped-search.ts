import type { RagDocument, RagRankCandidate, RagSearchScope } from './contracts.js'
import type { createSqlRagPersistentIndexReader } from './persistent-index.js'
import { createRagLexicalIndex } from './lexical-index.js'
import { rankCandidates } from './ranking/rank-candidates.js'
import { readRagDocumentVectors, type RagVectorSource } from './vector-reader.js'

export interface ScopedRagVectors {
  version: string
  source(owner: string, signal?: AbortSignal): Promise<RagVectorSource>
  embed(owner: string, query: string, signal?: AbortSignal): Promise<readonly number[]>
  readDocuments?(owner: string, documents: readonly RagDocument[], signal?: AbortSignal): Promise<Record<string, number[]>>
}

/** 身份、scope、授权快照、向量文件和 embedding 均由可信 Host 提供。 */
export function createScopedRagSearch(ports:{
 index:ReturnType<typeof createSqlRagPersistentIndexReader>
 authorize(owner:string,scope:RagSearchScope,signal?:AbortSignal):Promise<boolean>
 /** 可选可信事实复核：在排序/向量/结果投影前裁剪过期索引与邻文；不能自行授予scope。 */
 filterDocuments?(documents:readonly RagDocument[],signal?:AbortSignal):Promise<readonly RagDocument[]>
 vectors?:ScopedRagVectors
}) {
 return async(owner:string,scope:RagSearchScope|readonly RagSearchScope[],query:string,options:{sourceTypes:readonly string[];limit:number;beforeMessageId?:number;selectionMode?:'confidence'|'top_k';excludeContentHashes?:readonly string[]},signal?:AbortSignal)=>{
  signal?.throwIfAborted()
  if(!options.sourceTypes.length||!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>50)throw new Error('RAG 查询参数无效')
  if(options.beforeMessageId!==undefined&&(!Number.isSafeInteger(options.beforeMessageId)||options.beforeMessageId<1))throw new Error('RAG 消息水位无效')
  const scopes:RagSearchScope[]=Array.isArray(scope)?structuredClone(scope):[structuredClone(scope as RagSearchScope)]
  if(!scopes.length||scopes.length>3)throw new Error('RAG 检索范围数量无效')
  const stageMs:Record<string,number>={}
  let stageStarted=performance.now(),fallbackReason:string|null=null
  const snapshots=[]
  for(const current of scopes){
   if(!await ports.authorize(owner,current,signal))throw new Error('RAG 检索未授权')
   signal?.throwIfAborted();snapshots.push(await ports.index.snapshotForScope(owner,current,signal))
  }
  stageMs.scope_snapshot_ms=Math.max(0,Math.round(performance.now()-stageStarted))
  stageStarted=performance.now()
  const snapshot={revision:snapshots.length===1?snapshots[0]!.revision:snapshots.map(value=>value.revision??'empty').join('|'),documents:[...new Map(snapshots.flatMap(value=>value.documents).map(document=>[document.id,document])).values()]}
  // 并集内全部文档均来自逐scope授权的快照；多scope在同一语料上统一排名和预算。
  const trustedScope=scopes.length===1?scopes[0]:undefined
  const allowed=new Set(options.sourceTypes)
  let documents=snapshot.documents.filter(doc=>{
   if(!allowed.has(doc.source_type))return false
   if(options.beforeMessageId===undefined||doc.source_type!=='conversation'||doc.metadata?.kind!=='message')return true
   const id=Number(doc.metadata.message_id)
   return Number.isSafeInteger(id)&&id>0&&id<options.beforeMessageId
  })
  if(ports.filterDocuments)documents=[...await ports.filterDocuments(documents,signal)].filter(doc=>allowed.has(doc.source_type)&&scopes.some(current=>{
   if(current.scope_type==='owner')return doc.scope_type==='owner'
   if(current.scope_type==='project'||current.scope_type==='folder')return doc.scope_type==='owner'&&String(doc.metadata?.[current.scope_type==='project'?'project_id':'folder_id']??'')===current.scope_id
   if(doc.platform!==current.platform||doc.bot_id!==current.bot_id||doc.group_id!==current.group_id)return false
   return doc.scope_type===current.scope_type&&doc.scope_id===current.scope_id||current.scope_type==='member'&&doc.scope_type==='group'
  }))
  stageMs.document_filter_ms=Math.max(0,Math.round(performance.now()-stageStarted))
  const index=createRagLexicalIndex(owner)
  index.replace(owner,snapshot.revision||'empty',documents)
  stageStarted=performance.now()
  let fused
  if(ports.vectors&&documents.length){
   let queryVector:readonly number[]=[]
   try{queryVector=await ports.vectors.embed(owner,query,signal)}catch{
    // embedding 传输不可用时按 Python 行为保留词法候选；调用方取消仍必须向上传播。
    signal?.throwIfAborted()
    fallbackReason='embedding_failed'
   }
   signal?.throwIfAborted()
   if(queryVector.length){
    const source=await ports.vectors.source(owner,signal)
    const vectorMap=await readRagDocumentVectors(documents,ports.vectors.version,source,signal,owner)
    const cached=await ports.vectors.readDocuments?.(owner,documents,signal)
    signal?.throwIfAborted()
    fused=index.searchHybrid(owner,query,50,options.sourceTypes,trustedScope,{vectors:new Map(Object.entries({...cached,...vectorMap})),queryVector,vectorVersion:ports.vectors.version,expectedVersion:ports.vectors.version})
   }else{
    // Python 在 embedding 未配置/请求失败时退回同一 owner scope 下的词法召回。
    if(!fallbackReason)fallbackReason='embedding_empty'
    const lexical=index.search(owner,query,50,options.sourceTypes,trustedScope)
    fused={...lexical,fusion:'bm25' as const,vectorDocCount:0}
   }
  }else{
   if(ports.vectors)fallbackReason='no_documents_for_embedding'
   const lexical=index.search(owner,query,50,options.sourceTypes,trustedScope)
   fused={...lexical,fusion:'bm25' as const,vectorDocCount:0}
  }
  stageMs.vector_retrieval_ms=Math.max(0,Math.round(performance.now()-stageStarted))
  const byId=new Map(documents.map(document=>[document.id,document]))
  const candidates:RagRankCandidate[]=fused.results.flatMap(hit=>{
   const document=byId.get(hit.id)
   if(!document)return []
   const semantic='semantic_score' in hit?hit.semantic_score:undefined
   return [{id:hit.id,source_type:hit.source_type,raw_score:hit.score,document,...(typeof semantic==='number'?{semantic_score:semantic}:{})}]
  })
  stageStarted=performance.now()
  const ranked=rankCandidates(query,candidates,{limit:options.limit,maxChars:3000,selectionMode:options.selectionMode??'top_k',excludeContentHashes:[...(options.excludeContentHashes??[])],corpusStatistics:index.statistics(owner)})
  stageMs.ranking_ms=Math.max(0,Math.round(performance.now()-stageStarted))
  signal?.throwIfAborted()
  stageStarted=performance.now()
  for(const current of scopes)if(!await ports.authorize(owner,current,signal))throw new Error('RAG 检索授权已撤销')
  stageMs.authorization_recheck_ms=Math.max(0,Math.round(performance.now()-stageStarted))
  signal?.throwIfAborted()
  return {results:ranked.results.map(item=>({...item,document:byId.get(item.id)!})),fusion:fused.fusion,vectorDocCount:fused.vectorDocCount,revision:snapshot.revision,
   diagnostics:{...ranked.diagnostics,stage_ms:stageMs,fallback_reason:fallbackReason}}
 }
}
