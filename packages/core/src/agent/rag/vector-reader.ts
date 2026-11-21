import { createHash } from 'node:crypto'
import type { RagDocument } from './contracts.js'
import { TtlCache } from './ttl-cache.js'

/** Host 负责按可信 owner 授权并读取对应文件；缺失文件返回 null。 */
export type RagVectorSource = (kind:'memory'|'knowledge'|'pattern',signal?:AbortSignal)=>Promise<string|null>

type ParsedVectorFile = { hash: string; value: Record<string, unknown> }
// 复用 1.7.7 的无 TTL、按内容 hash 失效及 LRU 8 项语义。Cache key 包含可信 owner，
// 避免不同 owner 的相同模型版本共享驻留向量文件；每次仍从 Host 授权来源取最新文件。
const vectorFileCache = new TtlCache<ParsedVectorFile>({ ttlMs: Infinity, maxEntries: 8 })

function parseVectorFile(raw: string, namespace: string, kind: 'memory'|'knowledge'|'pattern', version: string): Record<string, unknown> {
 const key = JSON.stringify([namespace, kind, version])
 const hash = createHash('sha256').update(raw).digest('hex')
 const cached = vectorFileCache.get(key)
 if (cached?.hash === hash) return cached.value
 let parsed: unknown
 try { parsed = JSON.parse(raw) } catch { parsed = null }
 const value = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
 vectorFileCache.set(key, { hash, value })
 return value
}

/** 使用 1.7.7 的版本和 chunk 键匹配已授权来源的向量。 */
export async function readRagDocumentVectors(documents:readonly RagDocument[],version:string,read:RagVectorSource,signal?:AbortSignal,cacheNamespace?:string):Promise<Record<string,number[]>> {
 if (!version || !documents.length) return {}
 signal?.throwIfAborted()
 const raw=await Promise.all((['memory','knowledge','pattern'] as const).map(kind=>read(kind,signal)))
 signal?.throwIfAborted()
 const kinds=['memory','knowledge','pattern'] as const
 const maps=raw.map((value,index)=>value===null?{}:cacheNamespace?parseVectorFile(value,cacheNamespace,kinds[index]!,version):parseUncachedVectorFile(value))
 const result:Record<string,number[]>={}
 for(const document of documents){
  // memory 索引的持久 parent ID 会加 scope 命名空间，避免 owner 内不同 IM
  // scope 覆盖同一 SQL 索引行；1.7.7 向量文件仍按原始 parent ID 存储。
  const parent=String(document.metadata?.memory_parent_id??document.parent_id??document.id),chunk=Number(document.chunk_index||0)
  const pattern=(document.metadata?.memory_source_id??document.source_id)==='pattern'
  const key=pattern?String(document.metadata?.vector_key||''):`rag:${parent}:${String(document.document_version||'')}:${chunk}`
  const map=maps[document.source_type==='knowledge'?1:pattern?2:0]!
  const item=map[key]
  if(!item || typeof item!=='object' || Array.isArray(item)) continue
  const entry=item as {t?:unknown;v?:unknown}
  if(entry.t===version && Array.isArray(entry.v) && entry.v.every(part=>typeof part==='number' && Number.isFinite(part))) result[String(document.id||`memory:${parent}:${chunk}`)]=[...entry.v]
 }
 return result
}

function parseUncachedVectorFile(raw:string):Record<string,unknown>{
 let parsed:unknown
 try{parsed=JSON.parse(raw)}catch{return {}}
 return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{}
}
