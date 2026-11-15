import { createHash } from 'node:crypto'
import type { RagDocument, RagSearchScope, RagSearchResult, RagSearchDiagnostics } from './contracts.js'
import { scoreTerms, termFrequency, tokenize as tokens } from './ranking/bm25.js'
import { rankingText } from './ranking/document-text.js'
import type { Posting } from './ranking/types.js'
type Document = RagDocument
type State = { revision:string; documents:Document[]; documentsById:Map<string,Document>; postings:Map<string,Posting>; lengths:Map<string,number>; docFreq:Map<string,number>; avgLength:number; totalLength:number; fingerprints:Map<string,string> }
function replaceInMemory(state: State, revision: string, documents: Document[]): void {
  state.revision = revision;
  state.documents = [];
  state.documentsById = new Map();
  state.fingerprints = new Map();
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
  const frequency = termFrequency(tokens(rankingText(document)));
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

interface InstallTiming {
  tokenizeMs: number;
  structureMs: number;
  documents: number;
  skippedDocuments: number;
}

/**
 * 词法指纹：参与 BM25/过滤/展示的字段规范化哈希。
 *
 * 对齐 Python agent/rag/delta.py 的契约——document_version / updated_at
 * 不参与（版本推进单独不构成重新索引的理由）。来源级重建会整表重写行
 * （indexed_at/updated_at 全部推新），install 阶段凭此指纹跳过内容未变的
 * 文档，避免对未变更正文反复分词（2026-09-14 冷加载尖峰的根因）。
 */
function lexicalFingerprint(document: Document): string {
  return createHash("sha256").update([
    document.source_type,
    document.parent_id ?? "",
    String(document.chunk_index ?? 0),
    String(document.chunk_count ?? 1),
    document.ranking_text ?? document.text ?? "",
    document.text ?? "",
    document.context_text ?? "",
    document.title ?? "",
    document.summary ?? "",
    document.scope_type,
    document.scope_id,
    document.platform ?? "",
    document.bot_id ?? "",
    document.group_id ?? "",
    JSON.stringify(document.metadata ?? null),
  ].join("\x1f")).digest("hex");
}

function patchInMemory(
  state: State,
  revision: string,
  upserts: Document[],
  deletes: string[],
  timing?: InstallTiming,
): void {
  // 逐条 removeDocument/addDocument 在冷启动全量补丁上是 O(n²)：每条 upsert 触发
  // 一次 documents 数组全量 filter 拷贝、每个词项 posting 一次 indexOf+splice 线性
  // 搬移——20237 条实测 install 68s，把 30s 构建预算顶爆（2026-09-13 devserver
  // 全量超时事故）。这里改成标记-清扫：账目（docFreq/lengths/documentsById）先
  // 全部处理完并收集脏词项，最后对脏词项 posting 一次性重建、documents 数组
  // 单次 filter。复杂度从 O(n²) 降到 O(总变更词项出现数)。
  const removedIds = new Set<string>(deletes);

  // 先识别内容未变的 upsert：词法指纹一致 → 保留现条目，不分词、不动账目。
  // 来源级重建整表重写行（updated_at/indexed_at 推新）时，这里把 install 的
  // 分词成本从「全表」压到「真实变更」。
  const fingerprintStart = timing ? performance.now() : 0;
  const changedUpserts: Document[] = [];
  for (const document of upserts) {
    const newFp = lexicalFingerprint(document);
    const existingFp = state.fingerprints.get(document.id);
    const existing = state.documentsById.get(document.id);
    const oldFp = existingFp ?? (existing ? lexicalFingerprint(existing) : null);
    if (existing !== undefined && oldFp === newFp && !removedIds.has(document.id)) {
      if (timing) timing.skippedDocuments += 1;
      continue;
    }
    state.fingerprints.set(document.id, newFp);
    changedUpserts.push(document);
    removedIds.add(document.id);
  }
  if (timing) timing.structureMs += performance.now() - fingerprintStart;

  const dirtyTerms = new Set<string>();
  // 同 id 多条 upsert 只保留最后一条（与原逐条 remove→add 的「后者胜」语义一致）。
  const added = new Map<string, { document: Document; frequency: Map<string, number> }>();
  for (const id of removedIds) {
    const existing = state.documentsById.get(id);
    if (!existing) continue;
    state.fingerprints.delete(id);
    const tokenizeStarted = performance.now();
    const frequency = termFrequency(tokens(rankingText(existing)));
    if (timing) {
      timing.tokenizeMs += performance.now() - tokenizeStarted;
      timing.documents += 1;
    }
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
  for (const document of changedUpserts) {
    const tokenizeStarted = performance.now();
    const frequency = termFrequency(tokens(rankingText(document)));
    if (timing) {
      timing.tokenizeMs += performance.now() - tokenizeStarted;
      timing.documents += 1;
    }
    const length = [...frequency.values()].reduce((sum, value) => sum + value, 0);
    state.lengths.set(document.id, length);
    state.totalLength += length;
    state.documentsById.set(document.id, document);
    added.set(document.id, { document, frequency });
    for (const term of frequency.keys()) {
      dirtyTerms.add(term);
      state.docFreq.set(term, (state.docFreq.get(term) ?? 0) + 1);
    }
  }
  // 新增侧按词项倒排预聚合：若在重建阶段对每个脏词项都扫一遍 added 全表，
  // 全量重灌场景仍是 O(dirtyTerms × n)（20237 条全量重灌实测仍 71s）。先按
  // 词项收集一次 [docId, count]，重建时只取自己的条目，整体线性。
  const structureStarted = timing ? performance.now() : 0;
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
  if (timing) timing.structureMs += performance.now() - structureStarted;
  state.revision = revision;
  state.avgLength = state.documents.length ? state.totalLength / state.documents.length : 0;
}

function matchesScope(document: Document, scope?: RagSearchScope): boolean {
  if (!scope) return true;
  if (scope.scope_type === "project" || scope.scope_type === "folder") {
    if (document.scope_type !== "owner") return false;
    const field = scope.scope_type === "project" ? "project_id" : "folder_id";
    return String(document.metadata?.[field] ?? "") === String(scope.scope_id ?? "");
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
 if(['project','folder'].includes(scope.scope_type) && !scope.scope_id)throw new Error('RAG 检索范围不完整')
 if(!['owner','group','member','project','folder'].includes(scope.scope_type))throw new Error('RAG 检索范围不受支持')
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


/** 每个实例仅绑定一个可信 owner；来源装载和 ACL 仍由 Host 承担。 */
export function createRagLexicalIndex(ownerId:string) {
 if (!ownerId.trim()) throw new Error('RAG owner 未指定')
 let state:State={revision:'',documents:[],documentsById:new Map(),postings:new Map(),lengths:new Map(),docFreq:new Map(),avgLength:0,totalLength:0,fingerprints:new Map()}
 function authorize(owner:string){if(owner!==ownerId)throw new Error('RAG owner 不匹配')}
 return {
  replace(owner:string,revision:string,documents:Document[]){authorize(owner);const next:State={revision:'',documents:[],documentsById:new Map(),postings:new Map(),lengths:new Map(),docFreq:new Map(),avgLength:0,totalLength:0,fingerprints:new Map()};replaceInMemory(next,revision,structuredClone(documents));state=next},
  patch(owner:string,baseRevision:string,revision:string,upserts:Document[],deletes:string[]){authorize(owner);if(state.revision!==baseRevision)throw new Error('RAG 索引版本不匹配');const next=structuredClone(state);const unique=[...new Map(upserts.map(item=>[item.id,item])).values()];patchInMemory(next,revision,structuredClone(unique),[...deletes]);state=next},
  search(owner:string,query:string,limit:number,allowedSources:ReadonlyArray<string>,scope:RagSearchScope){authorize(owner);validateScope(scope);return structuredClone(search(state,query,limit,new Set(allowedSources),scope))},
  revision(){return state.revision},
 }
}
