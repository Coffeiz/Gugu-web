import type { RagDocument } from './contracts.js'

/** Host 负责按可信 owner 授权并读取对应文件；缺失文件返回 null。 */
export type RagVectorSource = (kind:'memory'|'knowledge'|'pattern',signal?:AbortSignal)=>Promise<string|null>

/** 使用 1.7.7 的版本和 chunk 键匹配已授权来源的向量。 */
export async function readRagDocumentVectors(documents:readonly RagDocument[],version:string,read:RagVectorSource,signal?:AbortSignal):Promise<Record<string,number[]>> {
 if (!version || !documents.length) return {}
 signal?.throwIfAborted()
 const raw=await Promise.all((['memory','knowledge','pattern'] as const).map(kind=>read(kind,signal)))
 signal?.throwIfAborted()
 const maps=raw.map(value=>{
  if (value===null) return {}
  let parsed:unknown
  try { parsed=JSON.parse(value) } catch { return {} }
  return parsed && typeof parsed==='object' && !Array.isArray(parsed) ? parsed as Record<string,unknown> : {}
 })
 const result:Record<string,number[]>={}
 for(const document of documents){
  // memory 索引的持久 parent ID 会加 scope 命名空间，避免 owner 内不同 IM
  // scope 覆盖同一 SQL 索引行；1.7.7 向量文件仍按原始 parent ID 存储。
  const parent=String(document.metadata?.memory_parent_id??document.parent_id??document.id),chunk=Number(document.chunk_index||0)
  const key=document.source_id==='pattern'?String(document.metadata?.vector_key||''):`rag:${parent}:${String(document.document_version||'')}:${chunk}`
  const map=maps[document.source_type==='knowledge'?1:document.source_id==='pattern'?2:0]!
  const item=map[key]
  if(!item || typeof item!=='object' || Array.isArray(item)) continue
  const entry=item as {t?:unknown;v?:unknown}
  if(entry.t===version && Array.isArray(entry.v) && entry.v.every(part=>typeof part==='number' && Number.isFinite(part))) result[String(document.id||`memory:${parent}:${chunk}`)]=[...entry.v]
 }
 return result
}
