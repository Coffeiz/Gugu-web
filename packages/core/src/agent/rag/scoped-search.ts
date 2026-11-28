import type { RagDocument, RagRankCandidate, RagSearchScope } from './contracts.js'
import type { createSqlRagPersistentIndexReader } from './persistent-index.js'
import { createRagLexicalIndex, rerankRagLexicalResults } from './lexical-index.js'
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
 lexicalCorpus?(owner: string, revision: string, documents: RagDocument[]): ReturnType<typeof createRagLexicalIndex>
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
  const snapshotTimings: Record<string, number> = {}
  const addSnapshotTiming = (stage: string, duration: number) => {
   snapshotTimings[stage] = (snapshotTimings[stage] ?? 0) + duration
  }
  const snapshots=[]
  for(const current of scopes){
   const authorizeStarted=performance.now()
   if(!await ports.authorize(owner,current,signal))throw new Error('RAG 检索未授权')
   addSnapshotTiming('snapshot_authorize_ms',performance.now()-authorizeStarted)
   signal?.throwIfAborted();snapshots.push(await ports.index.snapshotForScope(owner,current,signal,addSnapshotTiming))
  }
  for (const [stage,duration] of Object.entries(snapshotTimings))stageMs[stage]=Math.round(duration)
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
   if(current.scope_type==='project')return doc.scope_type==='owner'&&String(doc.metadata?.project_id??'')===current.scope_id
   if(doc.platform!==current.platform||doc.bot_id!==current.bot_id||doc.group_id!==current.group_id)return false
   return doc.scope_type===current.scope_type&&doc.scope_id===current.scope_id||current.scope_type==='member'&&doc.scope_type==='group'
  }))
  stageMs.document_filter_ms=Math.max(0,Math.round(performance.now()-stageStarted))
  stageStarted=performance.now()
  const revision=snapshot.revision||'empty'
  const index=ports.lexicalCorpus?.(owner,revision,documents)
    ?? createRagLexicalIndex(owner)
  if(!ports.lexicalCorpus)index.replace(owner,revision,documents)
  stageMs.lexical_sync_ms=Math.round(performance.now()-stageStarted)
  const searchStarted=performance.now()
  const lexical=index.search(owner,query,50,options.sourceTypes,trustedScope)
  // 向量读取可能与另一个 Run 交错，锁定本轮排名使用的词频统计。
  stageMs.lexical_search_ms=Math.round(performance.now()-searchStarted)
  const statistics=index.statistics(owner)
  stageMs.lexical_retrieval_ms=Math.round(performance.now()-stageStarted)

  const byId=new Map(documents.map(document=>[document.id,document]))
  const fused=await (async ()=>{
   const lexicalOnly={...lexical,fusion:'bm25' as const,vectorDocCount:0}
   const vectors=ports.vectors
   if(!vectors?.version)return lexicalOnly
   if(!lexical.results.length){
    fallbackReason=documents.length?'no_lexical_hits':'no_documents_for_embedding'
    return lexicalOnly
   }
   const hits=lexical.results.map(hit=>byId.get(hit.id)!)
   stageStarted=performance.now()
   const source=await vectors.source(owner,signal)
   const vectorMap=await readRagDocumentVectors(hits,vectors.version,source,signal,owner)
   const cached=await vectors.readDocuments?.(owner,hits,signal)
   signal?.throwIfAborted()
   const documentVectors=new Map(Object.entries({...cached,...vectorMap}).filter(([,vector])=>vector.length>0))
   stageMs.document_vectors_ms=Math.round(performance.now()-stageStarted)
   if(!documentVectors.size){
    fallbackReason='no_matching_document_vectors'
    return lexicalOnly
   }

   stageStarted=performance.now()
   let queryVector:readonly number[]
   try{queryVector=await vectors.embed(owner,query,signal)}catch{
    // embedding 传输失败时保留同一授权范围内的词法结果，调用方取消仍向上传播。
    signal?.throwIfAborted()
    fallbackReason='embedding_failed'
    queryVector=[]
   }
   stageMs.query_embedding_ms=Math.round(performance.now()-stageStarted)
   signal?.throwIfAborted()
   if(!queryVector.length){
    fallbackReason??='embedding_empty'
    return lexicalOnly
   }
   stageStarted=performance.now()
   const result=rerankRagLexicalResults(lexical,queryVector,documentVectors)
   stageMs.vector_fusion_ms=Math.round(performance.now()-stageStarted)
   return result
  })()
  const candidates:RagRankCandidate[]=fused.results.flatMap(hit=>{
   const document=byId.get(hit.id)
   if(!document)return []
   const semantic='semantic_score' in hit?hit.semantic_score:undefined
   return [{id:hit.id,source_type:hit.source_type,raw_score:hit.score,document,...(typeof semantic==='number'?{semantic_score:semantic}:{})}]
  })
  stageStarted=performance.now()
  const ranked=rankCandidates(query,candidates,{limit:options.limit,maxChars:3000,selectionMode:options.selectionMode??'top_k',excludeContentHashes:[...(options.excludeContentHashes??[])],corpusStatistics:statistics})
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
