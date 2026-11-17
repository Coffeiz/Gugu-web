import type { RagRankCandidate, RagSearchScope } from './contracts.js'
import type { createSqlRagPersistentIndexReader } from './persistent-index.js'
import { createRagLexicalIndex } from './lexical-index.js'
import { rankCandidates } from './ranking/rank-candidates.js'
import { readRagDocumentVectors, type RagVectorSource } from './vector-reader.js'

/** 身份、scope、授权快照、向量文件和 embedding 均由可信 Host 提供。 */
export function createScopedRagSearch(ports:{
 index:ReturnType<typeof createSqlRagPersistentIndexReader>
 authorize(owner:string,scope:RagSearchScope,signal?:AbortSignal):Promise<boolean>
 vectors?:{version:string;source(owner:string,signal?:AbortSignal):Promise<RagVectorSource>;embed(owner:string,query:string,signal?:AbortSignal):Promise<readonly number[]>}
}) {
 return async(owner:string,scope:RagSearchScope,query:string,options:{sourceTypes:readonly string[];limit:number;beforeMessageId?:number;selectionMode?:'confidence'|'top_k';excludeContentHashes?:readonly string[]},signal?:AbortSignal)=>{
  signal?.throwIfAborted()
  if(!options.sourceTypes.length||!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>50)throw new Error('RAG 查询参数无效')
  if(options.beforeMessageId!==undefined&&(!Number.isSafeInteger(options.beforeMessageId)||options.beforeMessageId<1))throw new Error('RAG 消息水位无效')
  const trustedScope=structuredClone(scope)
  if(!await ports.authorize(owner,trustedScope,signal))throw new Error('RAG 检索未授权')
  signal?.throwIfAborted()
  const snapshot=await ports.index.snapshotForScope(owner,trustedScope,signal)
  const allowed=new Set(options.sourceTypes)
  const documents=snapshot.documents.filter(doc=>{
   if(!allowed.has(doc.source_type))return false
   if(options.beforeMessageId===undefined||doc.source_type!=='conversation'||doc.metadata?.kind!=='message')return true
   const id=Number(doc.metadata.message_id)
   return Number.isSafeInteger(id)&&id>0&&id<options.beforeMessageId
  })
  const index=createRagLexicalIndex(owner)
  index.replace(owner,snapshot.revision||'empty',documents)
  let fused
  if(ports.vectors&&documents.length){
   let queryVector:readonly number[]=[]
   try{queryVector=await ports.vectors.embed(owner,query,signal)}catch{
    // embedding 传输不可用时按 Python 行为保留词法候选；调用方取消仍必须向上传播。
    signal?.throwIfAborted()
   }
   signal?.throwIfAborted()
   if(queryVector.length){
    const source=await ports.vectors.source(owner,signal)
    const vectorMap=await readRagDocumentVectors(documents,ports.vectors.version,source,signal,owner)
    signal?.throwIfAborted()
    fused=index.searchHybrid(owner,query,50,options.sourceTypes,trustedScope,{vectors:new Map(Object.entries(vectorMap)),queryVector,vectorVersion:ports.vectors.version,expectedVersion:ports.vectors.version})
   }else{
    // Python 在 embedding 未配置/请求失败时退回同一 owner scope 下的词法召回。
    const lexical=index.search(owner,query,50,options.sourceTypes,trustedScope)
    fused={...lexical,fusion:'bm25' as const,vectorDocCount:0}
   }
  }else{
   const lexical=index.search(owner,query,50,options.sourceTypes,trustedScope)
   fused={...lexical,fusion:'bm25' as const,vectorDocCount:0}
  }
  const byId=new Map(documents.map(document=>[document.id,document]))
  const candidates:RagRankCandidate[]=fused.results.flatMap(hit=>{
   const document=byId.get(hit.id)
   if(!document)return []
   const semantic='semantic_score' in hit?hit.semantic_score:undefined
   return [{id:hit.id,source_type:hit.source_type,raw_score:hit.score,document,...(typeof semantic==='number'?{semantic_score:semantic}:{})}]
  })
  const ranked=rankCandidates(query,candidates,{limit:options.limit,maxChars:3000,selectionMode:options.selectionMode??'top_k',excludeContentHashes:[...(options.excludeContentHashes??[])],corpusStatistics:index.statistics(owner)})
  signal?.throwIfAborted()
  if(!await ports.authorize(owner,trustedScope,signal))throw new Error('RAG 检索授权已撤销')
  signal?.throwIfAborted()
  return {results:ranked.results.map(item=>({...item,document:byId.get(item.id)!})),fusion:fused.fusion,vectorDocCount:fused.vectorDocCount,revision:snapshot.revision,diagnostics:ranked.diagnostics}
 }
}
