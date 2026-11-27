import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { RagDocument, RagSearchScope, RagSearchResult, RagSearchDiagnostics } from './contracts.js'
import { corpusStatistics, scoreTerms, termFrequency, tokenize as tokens } from './ranking/bm25.js'
import { rankingText } from './ranking/document-text.js'
import type { Posting } from './ranking/types.js'
import { hybridFuseScores } from './ranking/hybrid.js'
type Document = RagDocument
type State = { revision:string; documents:Document[]; documentsById:Map<string,Document>; postings:Map<string,Posting>; lengths:Map<string,number>; docFreq:Map<string,number>; avgLength:number; totalLength:number }

function tokenizeDocument(document: Document): ReadonlyMap<string, number> {
  return termFrequency(tokens(rankingText(document)))
}

function replaceInMemory(state: State, revision: string, documents: Document[]): void {
  state.revision = revision;
  state.documents = [];
  state.documentsById = new Map();
  state.postings = new Map();
  state.lengths = new Map();
  state.docFreq = new Map();
  state.totalLength = 0;
  for (const document of documents) addDocument(state, document);
  state.avgLength = state.documents.length ? state.totalLength / state.documents.length : 0;
}

function addDocument(state: State, document: Document): void {
  state.documents.push(document);
  state.documentsById.set(document.id, document);
  const frequency = tokenizeDocument(document);
  const length = [...frequency.values()].reduce((sum, value) => sum + value, 0);
  state.lengths.set(document.id, length);
  state.totalLength += length;
  for (const [term, count] of frequency) {
    const posting = state.postings.get(term) ?? { ids: [], frequencies: [] };
    posting.ids.push(document.id);
    posting.frequencies.push(count);
    state.postings.set(term, posting);
    state.docFreq.set(term, (state.docFreq.get(term) ?? 0) + 1);
  }
}

function patchInMemory(state: State, revision: string, upserts: Document[], deletes: string[]): void {
  // 先收集变更文档，再一次性重建受影响词项的倒排列表。
  const removedIds = new Set([...deletes, ...upserts.map(document => document.id)]);
  // 分词可能失败。先算完词频，再修改当前可检索的索引。
  const removed = new Map<string, ReadonlyMap<string, number>>();
  for (const id of removedIds) {
    const existing = state.documentsById.get(id);
    if (existing) removed.set(id, tokenizeDocument(existing));
  }
  const added = new Map(upserts.map(document => [document.id, { document, frequency: tokenizeDocument(document) }]));
  const dirtyTerms = new Set<string>();
  for (const [id, frequency] of removed) {
    state.totalLength -= state.lengths.get(id) ?? 0;
    state.lengths.delete(id);
    state.documentsById.delete(id);
    for (const term of frequency.keys()) {
      dirtyTerms.add(term);
      const count = (state.docFreq.get(term) ?? 0) - 1;
      if (count > 0) state.docFreq.set(term, count);
      else state.docFreq.delete(term);
    }
  }
  for (const { document, frequency } of added.values()) {
    const length = [...frequency.values()].reduce((sum, value) => sum + value, 0);
    state.lengths.set(document.id, length);
    state.totalLength += length;
    state.documentsById.set(document.id, document);
    for (const term of frequency.keys()) {
      dirtyTerms.add(term);
      state.docFreq.set(term, (state.docFreq.get(term) ?? 0) + 1);
    }
  }
  // 新增侧按词项倒排预聚合：若在重建阶段对每个脏词项都扫一遍 added 全表，
  // 全量重灌场景仍是 O(dirtyTerms × n)（20237 条全量重灌实测仍 71s）。先按
  // 词项收集一次 [docId, count]，重建时只取自己的条目，整体线性。
  const addsByTerm = new Map<string, Array<[string, number]>>();
  for (const [docId, entry] of added) {
    for (const [term, count] of entry.frequency) {
      const list = addsByTerm.get(term);
      if (list) list.push([docId, count]);
      else addsByTerm.set(term, [[docId, count]]);
    }
  }
  // 脏词项 posting 重建：旧条目过滤掉全部移除 id，再补上新增文档词频。
  // 注意 docFreq 已按「先减后加」定稿；词项计数归零时旧 posting 可能已在
  // 账目阶段删掉，重建按空 posting 起步，空结果则删除词项。
  for (const term of dirtyTerms) {
    const old = state.postings.get(term) ?? { ids: [], frequencies: [] };
    const ids: string[] = [];
    const frequencies: number[] = [];
    for (let i = 0; i < old.ids.length; i++) {
      if (removedIds.has(old.ids[i]!)) continue;
      ids.push(old.ids[i]!);
      frequencies.push(old.frequencies[i]!);
    }
    for (const [docId, count] of addsByTerm.get(term) ?? []) {
      ids.push(docId);
      frequencies.push(count);
    }
    if (ids.length > 0) state.postings.set(term, { ids, frequencies });
    else state.postings.delete(term);
  }
  state.documents = state.documents.filter((item) => !removedIds.has(item.id));
  for (const entry of added.values()) state.documents.push(entry.document);
  state.revision = revision;
  state.avgLength = state.documents.length ? state.totalLength / state.documents.length : 0;
}

function matchesScope(document: Document, scope?: RagSearchScope): boolean {
  if (!scope) return true;
  if (scope.scope_type === "project") {
    if (document.scope_type !== "owner") return false;
    return String(document.metadata?.project_id ?? "") === String(scope.scope_id ?? "");
  }
  if (scope.scope_type === "member" && document.scope_type === "group") {
    return document.platform === scope.platform
      && document.bot_id === scope.bot_id
      && document.group_id === scope.group_id;
  }
  for (const key of ["platform", "bot_id", "group_id", "scope_type", "scope_id"] as const) {
    const wanted = scope[key];
    if (wanted && document[key] !== wanted) return false;
  }
  return true;
}

function validateScope(scope:RagSearchScope):void {
 if(!scope?.scope_type)throw new Error('RAG 检索范围未指定')
 if(['group','member'].includes(scope.scope_type) && (!scope.platform || !scope.bot_id || !scope.group_id || !scope.scope_id)) throw new Error('RAG 检索范围不完整')
 if(scope.scope_type === 'project' && !scope.scope_id)throw new Error('RAG 检索范围不完整')
 if(!['owner','group','member','project'].includes(scope.scope_type))throw new Error('RAG 检索范围不受支持')
}

function search(
  state: State,
  query: string,
  limit: number,
  allowedSources: Set<string>,
  scope?: RagSearchScope,
  preparedScores?: Map<string, number>,
  preparedTerms?: Set<string>,
): { results: RagSearchResult[]; diagnostics: RagSearchDiagnostics } {
  const started = performance.now();
  const terms = preparedTerms ?? new Set(tokens(query));
  if (!terms.size) {
    return {
      results: [],
      diagnostics: {
        candidate_count: state.documents.length,
        eligible_count: 0,
        filtered_count: state.documents.length,
        source_filter_applied: allowedSources.size > 0,
        scope_filter_applied: scope !== undefined,
        elapsed_ms: Math.round(performance.now() - started),
      },
    };
  }
  const scored: RagSearchResult[] = [];
  let eligibleCount = 0;
  state.documents.forEach((document) => {
    if ((allowedSources.size && !allowedSources.has(document.source_type)) || !matchesScope(document, scope)) return;
    eligibleCount += 1;
  });
  const scores = preparedScores ?? scoreTerms(state, terms);
  for (const [id, score] of scores) {
    const document = state.documentsById.get(id);
    if (document && score > 0 && (!allowedSources.size || allowedSources.has(document.source_type)) && matchesScope(document, scope)) scored.push({ id, score, source_type: document.source_type, document_version: document.document_version!, document });
  }
  return {
    results: scored
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id, "en-US"))
      .slice(0, Math.max(1, Math.min(limit, 50))),
    diagnostics: {
      candidate_count: state.documents.length,
      eligible_count: eligibleCount,
      filtered_count: state.documents.length - eligibleCount,
      source_filter_applied: allowedSources.size > 0,
      scope_filter_applied: scope !== undefined,
      elapsed_ms: Math.round(performance.now() - started),
    },
  };
}


/** 向量只对已经进入词法候选的文档重排。 */
export function rerankRagLexicalResults(
 lexical: ReturnType<typeof search>, queryVector: readonly number[], documentVectors: ReadonlyMap<string, readonly number[]>,
) {
 if(!queryVector.every(Number.isFinite))throw new Error('RAG 查询向量无效')
 const hits=lexical.results.map(row=>({chunk_id:row.id}))
 const vectors=new Map<string,readonly number[]>()
 for(const hit of hits){const value=documentVectors.get(hit.chunk_id);if(value?.every(Number.isFinite))vectors.set(hit.chunk_id,value)}
 const {fusedScores,vectorScores}=hybridFuseScores(hits,queryVector,vectors)
 if(!fusedScores.size)return {...structuredClone(lexical),fusion:'bm25' as const,vectorDocCount:0}
 const results=lexical.results.map(row=>({...row,score:fusedScores.get(row.id)!,...(vectorScores.has(row.id)?{semantic_score:vectorScores.get(row.id)!}:{})}))
  .sort((a,b)=>b.score-a.score||(a.id<b.id?-1:a.id>b.id?1:0))
 return {results:structuredClone(results),diagnostics:structuredClone(lexical.diagnostics),fusion:'hybrid-rrf' as const,vectorDocCount:vectorScores.size}
}

/** 每个实例仅绑定一个可信 owner；来源装载和 ACL 仍由 Host 承担。 */
export function createRagLexicalIndex(ownerId:string) {
 if (!ownerId.trim()) throw new Error('RAG owner 未指定')
 let state:State={revision:'',documents:[],documentsById:new Map(),postings:new Map(),lengths:new Map(),docFreq:new Map(),avgLength:0,totalLength:0}
 function authorize(owner:string){if(owner!==ownerId)throw new Error('RAG owner 不匹配')}
 return {
  replace(owner:string,revision:string,documents:Document[]){authorize(owner);const next:State={revision:'',documents:[],documentsById:new Map(),postings:new Map(),lengths:new Map(),docFreq:new Map(),avgLength:0,totalLength:0};replaceInMemory(next,revision,structuredClone(documents));state=next},
  async warm(owner: string, revision: string, documents: readonly Document[]) {
   authorize(owner)
   const next: State = { revision, documents: [], documentsById: new Map(), postings: new Map(),
     lengths: new Map(), docFreq: new Map(), avgLength: 0, totalLength: 0 }
   for (let offset = 0; offset < documents.length; offset += 32) {
    await yieldToEventLoop(undefined, { ref: false })
    for (const document of documents.slice(offset, offset + 32)) addDocument(next, structuredClone(document))
   }
   next.avgLength = next.documents.length ? next.totalLength / next.documents.length : 0
   state = next
  },
  /** 用本轮完整授权语料核对增删改，版本和历史水位可以独立变化。 */
  synchronize(owner: string, revision: string, documents: Document[]) {
   authorize(owner)
   const current = new Set(documents.map(document => document.id))
   const deletes = state.documents.filter(document => !current.has(document.id)).map(document => document.id)
   const upserts: Document[] = []
   const refreshed = new Map<string, Document>()
   for (const document of documents) {
    const previous = state.documentsById.get(document.id)
    if (isDeepStrictEqual(document, previous)) continue
    if (previous && rankingText(previous) === rankingText(document)) refreshed.set(document.id, structuredClone(document))
    else upserts.push(document)
   }
   if (upserts.length || deletes.length) patchInMemory(state, revision, structuredClone(upserts), deletes)
   else state.revision = revision
   if (refreshed.size) {
    state.documents = state.documents.map(document => refreshed.get(document.id) ?? document)
    for (const [id, document] of refreshed) {
     state.documentsById.set(id, document)
    }
   }
  },
  search(owner:string,query:string,limit:number,allowedSources:ReadonlyArray<string>,scope?:RagSearchScope){authorize(owner);if(scope)validateScope(scope);return structuredClone(search(state,query,limit,new Set(allowedSources),scope))},
  searchHybrid(owner:string,query:string,limit:number,allowedSources:ReadonlyArray<string>,scope: RagSearchScope | undefined,options:{queryVector:readonly number[];vectorVersion:string;expectedVersion:string;vectors:ReadonlyMap<string,readonly number[]>}){
   authorize(owner);if(scope)validateScope(scope)
   if(!options.queryVector.every(Number.isFinite))throw new Error('RAG 查询向量无效')
   const lexical=search(state,query,limit,new Set(allowedSources),scope)
   if(!options.expectedVersion||options.vectorVersion!==options.expectedVersion||!options.queryVector.length||!options.vectors.size)return {...structuredClone(lexical),fusion:'bm25' as const,vectorDocCount:0}
   return rerankRagLexicalResults(lexical, options.queryVector, options.vectors)
  },
  revision(){return state.revision},
  statistics(owner:string){authorize(owner);return structuredClone(corpusStatistics(state))},
 }
}

/** 以 owner 隔离近期词法语料，同一 owner 的冷启动只安排一次。 */
export function createRagLexicalCorpusCache() {
 const recent = new Map<string, { index?: ReturnType<typeof createRagLexicalIndex>; size: number }>()
 const warming = new Set<string>()
 const maxDocuments = 50_000
 function retain(key: string, index: ReturnType<typeof createRagLexicalIndex> | undefined, size: number) {
  recent.delete(key)
  recent.set(key, { index, size })
  let total = [...recent.values()].reduce((sum, entry) => sum + entry.size, 0)
  while (recent.size > 1 && (recent.size > 4 || total > maxDocuments)) {
   const oldest = recent.entries().next().value
   if (!oldest) break
   total -= oldest[1].size
   recent.delete(oldest[0])
  }
 }
 const cacheKey = (owner: string, scope: string) => JSON.stringify([owner, scope])
 function synchronize(owner: string, revision: string, documents: Document[], key: string, pinned?: ReturnType<typeof createRagLexicalIndex>) {
  const previous = recent.get(key)?.index ?? pinned
  recent.delete(key)
  const index = previous ?? createRagLexicalIndex(owner)
  if (previous) index.synchronize(owner, revision, documents)
  else index.replace(owner, revision, documents)
  if (documents.length <= maxDocuments) retain(key, index, documents.length)
  else retain(key, undefined, 0)
  return index
 }
 const use = (owner: string, revision: string, documents: Document[], scope = '') =>
  synchronize(owner, revision, documents, cacheKey(owner, scope))
 return Object.assign(use, {
  bindReady(owner: string, scope: string) {
   const key = cacheKey(owner, scope)
   const entry = recent.get(key)
   if (!entry) return undefined
   const pinned = entry.index
   // 查询期间即使发生 LRU 淘汰，也能使用已预热的索引核对当前文档。
   return (candidate: string, revision: string, documents: Document[]) => {
    if (candidate !== owner) throw new Error('RAG owner 不匹配')
    return synchronize(owner, revision, documents, key, pinned)
   }
  },
  warm(owner: string, load: () => Promise<{ revision: string | null; documents: Document[] }>, scope = '') {
   const key = cacheKey(owner, scope)
   if (warming.has(key) || warming.size >= 2 || recent.has(key)) return
   warming.add(key)
   void (async () => {
    await yieldToEventLoop(undefined, { ref: false })
    const { revision, documents } = await load()
    const unique = [...new Map(documents.map(document => [document.id, document])).values()]
    if (unique.length > maxDocuments) {
     if (!recent.has(key)) retain(key, undefined, 0)
     return
    }
    const index = createRagLexicalIndex(owner)
    await index.warm(owner, revision ?? 'empty', unique)
    if (!recent.has(key)) retain(key, index, unique.length)
   })().catch(() => {
    // 预热独立于当前对话，失败后允许下一次自动召回重试。
   }).finally(() => { warming.delete(key) })
  },
 })
}
