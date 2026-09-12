import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  RagDocument,
  RagIndexLoadProbe,
  RagRankCandidate,
  RagRequest,
  RagResponse,
  RagSearchDiagnostics,
  RagSearchScope,
  RagSearchResult,
} from "../../../packages/contracts/src/rag.ts";
import { RAG_WORKER_VERSION } from "../../../packages/contracts/src/rag.ts";
import { createPostgresClient } from "../../../packages/data-runtime/src/postgres.ts";
import { DataRuntime } from "../../../packages/data-runtime/src/runtime.ts";
import { createStorageReaderFromEnv } from "../../../packages/data-runtime/src/storage-reader.ts";
import { tokenizeRaw } from "./tokenizer.ts";
import { buildSourceDocuments, type RagSourceBatch } from "./index-builder.ts";
import { rankCandidates } from "./service.ts";
import { corpusStatistics, mergeCorpusStatistics, scoreTerms, termFrequency, tokenize as tokens } from "./ranking/bm25.ts";
import { rankingText } from "./ranking/document-text.ts";
import type { Posting } from "./ranking/types.ts";
import { loadDocumentVectors, prepareMemory, type AuthorizedMemoryScope } from "./memory-loader.ts";

const VERSION = RAG_WORKER_VERSION;

type Document = RagDocument;
type WorkerProbe = RagIndexLoadProbe;
type State = {
  revision: string;
  restoreError: string | null;
  restoreProbe: RagIndexLoadProbe;
  /** 向量驻留表；键 = worker 文档键。transient 槽放 Memory 快照向量，
   * persistent 槽放 knowledge 等持久来源向量（随 replace/patch 整表搭载、可落盘）。 */
  vectors: Map<string, number[]>;
  vectorVersion: string;
  documents: Document[];
  documentsById: Map<string, Document>;
  postings: Map<string, Posting>;
  lengths: Map<string, number>;
  docFreq: Map<string, number>;
  avgLength: number;
  totalLength: number;
  indexDir?: string;
};

/** 与 Python hybrid_results 逐位一致的融合核心：cosine 含 sqrt、
 * 维度不匹配/零向量记 0.0 但保留向量名次；返回每个命中的融合分与向量候选数。 */
function hybridFuseScores(
  hits: Array<{ chunk_id: string }>,
  queryVector: number[],
  vectors: Record<string, number[]> | Map<string, number[]>,
  lexicalWeight: number,
  vectorWeight: number,
  rrfK: number,
): { fusedScores: Map<string, number>; vectorDocCount: number; vectorScores: Map<string, number> } {
  const getVector = (key: string): number[] | undefined =>
    vectors instanceof Map ? vectors.get(key) : vectors[key];
  const vectorScores = new Map<string, number>();
  for (const hit of hits) {
    const key = String(hit.chunk_id);
    const vector = getVector(key);
    // Python 只把 vector_map 里有非空向量的候选算进 vector_scores；
    // 维度不匹配（换过模型的脏数据）或零向量 → 0.0，但保留向量名次。
    if (!Array.isArray(vector) || vector.length === 0) continue;
    if (queryVector.length !== vector.length) {
      vectorScores.set(key, 0);
      continue;
    }
    let dot = 0, na = 0, nb = 0;
    for (let index = 0; index < queryVector.length; index += 1) {
      dot += queryVector[index] * vector[index];
      na += queryVector[index] * queryVector[index];
      nb += vector[index] * vector[index];
    }
    vectorScores.set(key, na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb)));
  }
  const fusedScores = new Map<string, number>();
  if (vectorScores.size === 0) {
    // vector_map 非空但命中都无可用向量时 Python 按纯词法 RRF 重打分；这里由
    // 调用方决定透传或重打分，空命中集返回空表。
    return { fusedScores, vectorDocCount: 0, vectorScores };
  }
  const rrf = (rank: number, weight: number) => weight * ((rrfK + 1) / (rrfK + Math.max(1, rank)));
  const lexicalRanks = new Map(hits.map((hit, index) => [String(hit.chunk_id), index + 1]));
  const vectorRanked = [...vectorScores.keys()].sort((left, right) =>
    vectorScores.get(right)! - vectorScores.get(left)! || (left < right ? -1 : 1));
  const vectorRanks = new Map(vectorRanked.map((key, index) => [key, index + 1]));
  for (const hit of hits) {
    const key = String(hit.chunk_id);
    let score = rrf(lexicalRanks.get(key) ?? 1, lexicalWeight);
    const vectorRank = vectorRanks.get(key);
    if (vectorRank !== undefined) score += rrf(vectorRank, vectorWeight);
    fusedScores.set(key, score);
  }
  return { fusedScores, vectorDocCount: vectorScores.size, vectorScores };
}

function makeState(indexDir?: string): State {
  return {
    revision: "", restoreError: null,
    restoreProbe: { stage_ms: {}, counts: {} },
    vectors: new Map(), vectorVersion: "",
    documents: [], documentsById: new Map(), postings: new Map(),
    lengths: new Map(), docFreq: new Map(), avgLength: 0, totalLength: 0, indexDir,
  };
}

function recordProbeStage(probe: WorkerProbe, name: string, started: number): void {
  probe.stage_ms[name] = Math.max(0, Math.round(performance.now() - started));
}

let dataRuntime: DataRuntime | null = null;
let storageReader: ReturnType<typeof createStorageReaderFromEnv> | null = null;

function assertWorkerOwner(ownerId: string): void {
  const boundOwner = String(process.env.GUGU_RAG_OWNER_ID || "").trim();
  if (!boundOwner || !ownerId || ownerId.toLowerCase() !== boundOwner.toLowerCase()) {
    throw new Error("RAG Worker 拒绝不匹配的 owner 范围");
  }
}

function getDataRuntime(): DataRuntime {
  if (dataRuntime) return dataRuntime;
  const databaseUrl = String(process.env.GUGU_DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("RAG Worker 未配置数据库读取通道");
  dataRuntime = new DataRuntime(createPostgresClient(databaseUrl, {
    max: 1,
    idleTimeout: 15,
    connectTimeout: 5,
  }));
  return dataRuntime;
}

function getStorageReader(): ReturnType<typeof createStorageReaderFromEnv> {
  if (!storageReader) storageReader = createStorageReaderFromEnv();
  return storageReader;
}

async function restore(state: State): Promise<void> {
  const operationStarted = performance.now();
  const probe: WorkerProbe = { stage_ms: {}, counts: {
    index_file_present: 0,
    index_file_bytes: 0,
    documents: 0,
    vectors: 0,
    restored: 0,
  } };
  if (!state.indexDir) {
    recordProbeStage(probe, "restore_total", operationStarted);
    state.restoreProbe = probe;
    return;
  }

  let stageStarted = performance.now();
  let raw: string;
  try {
    raw = await readFile(join(state.indexDir, "index.json"), "utf8");
  } catch {
    // 首次冷启动没有索引文件，不属于损坏。
    recordProbeStage(probe, "restore_read_file", stageStarted);
    recordProbeStage(probe, "restore_total", operationStarted);
    state.restoreProbe = probe;
    return;
  }
  recordProbeStage(probe, "restore_read_file", stageStarted);
  probe.counts.index_file_present = 1;
  probe.counts.index_file_bytes = Buffer.byteLength(raw, "utf8");

  // 恢复失败由上层 replace 重建；结局必须显式可观测，不能伪装成有数据或无声跳过。
  stageStarted = performance.now();
  let parsed: {
    version?: string; revision?: string; documents?: Document[];
    vectors?: Record<string, number[]>; vector_version?: string;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    recordProbeStage(probe, "restore_json_parse", stageStarted);
    recordProbeStage(probe, "restore_total", operationStarted);
    state.restoreError = "corrupt";
    state.restoreProbe = probe;
    return;
  }
  recordProbeStage(probe, "restore_json_parse", stageStarted);
  if (parsed.version !== VERSION) {
    state.restoreError = "version_mismatch";
    recordProbeStage(probe, "restore_total", operationStarted);
    state.restoreProbe = probe;
    return;
  }

  stageStarted = performance.now();
  try {
    replaceInMemory(state, parsed.revision ?? "", parsed.documents ?? []);
    recordProbeStage(probe, "restore_index_install", stageStarted);
    probe.counts.documents = state.documents.length;
    stageStarted = performance.now();
    state.vectors = new Map(Object.entries(parsed.vectors ?? {}));
    recordProbeStage(probe, "restore_vector_map", stageStarted);
    probe.counts.vectors = state.vectors.size;
    state.vectorVersion = String(parsed.vector_version ?? "");
    probe.counts.restored = 1;
  } catch {
    state.restoreError = "corrupt";
    if (probe.stage_ms.restore_index_install === undefined) {
      recordProbeStage(probe, "restore_index_install", stageStarted);
    } else {
      recordProbeStage(probe, "restore_vector_map", stageStarted);
    }
  }
  recordProbeStage(probe, "restore_total", operationStarted);
  state.restoreProbe = probe;
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

function removeDocument(state: State, id: string): void {
  const document = state.documentsById.get(id);
  if (!document) return;
  const frequency = termFrequency(tokens(rankingText(document)));
  const length = state.lengths.get(id) ?? 0;
  state.totalLength -= length;
  for (const term of frequency.keys()) {
    const posting = state.postings.get(term);
    if (!posting) continue;
    const position = posting.ids.indexOf(id);
    if (position >= 0) {
      posting.ids.splice(position, 1);
      posting.frequencies.splice(position, 1);
    }
    const count = (state.docFreq.get(term) ?? 0) - 1;
    if (count > 0) state.docFreq.set(term, count);
    else { state.docFreq.delete(term); state.postings.delete(term); }
  }
  state.documents = state.documents.filter((item) => item.id !== id);
  state.documentsById.delete(id);
  state.lengths.delete(id);
}

function patchInMemory(state: State, revision: string, upserts: Document[], deletes: string[]): void {
  for (const id of deletes) removeDocument(state, id);
  for (const document of upserts) {
    removeDocument(state, document.id);
    addDocument(state, document);
  }
  state.revision = revision;
  state.avgLength = state.documents.length ? state.totalLength / state.documents.length : 0;
}

async function persist(state: State, probe?: WorkerProbe): Promise<void> {
  const operationStarted = performance.now();
  if (!state.indexDir) {
    if (probe) {
      probe.stage_ms.persist_total = 0;
      probe.counts.index_persisted = 0;
    }
    return;
  }
  let stageStarted = performance.now();
  await mkdir(state.indexDir, { recursive: true, mode: 0o700 });
  if (probe) recordProbeStage(probe, "persist_directory_prepare", stageStarted);
  const target = join(state.indexDir, "index.json");
  const temporary = `${target}.tmp`;
  stageStarted = performance.now();
  const serialized = JSON.stringify({
    version: VERSION, revision: state.revision, documents: state.documents,
    vectors: Object.fromEntries(state.vectors), vector_version: state.vectorVersion,
  });
  if (probe) {
    recordProbeStage(probe, "persist_serialize", stageStarted);
    probe.counts.serialized_bytes = Buffer.byteLength(serialized, "utf8");
  }
  stageStarted = performance.now();
  await writeFile(temporary, serialized, { mode: 0o600 });
  await rename(temporary, target);
  if (probe) {
    recordProbeStage(probe, "persist_write_and_rename", stageStarted);
    recordProbeStage(probe, "persist_total", operationStarted);
    probe.counts.index_persisted = 1;
  }
}

/** replace/patch 携带向量时的整表替换：Python 每次索引构建都随载全量当前映射，
 * 因此直接整表覆盖即可自清理已删除文档，不保留增量残留。 */
function applyVectorMap(state: State, request: { vectors?: Record<string, number[]>; vector_version?: string }): void {
  if (request.vectors === undefined) return;
  state.vectors = new Map(Object.entries(request.vectors ?? {}));
  state.vectorVersion = String(request.vector_version ?? "");
}

function validateStoredVectorOwner(request: { vector_cache?: { owner_id: string } }): void {
  if (request.vector_cache) assertWorkerOwner(String(request.vector_cache.owner_id || ""));
}

async function applyStoredVectorCache(
  state: State,
  request: {
    vector_cache?: { owner_id: string; vector_version: string };
    vectors?: Record<string, number[]>;
    vector_version?: string;
  },
): Promise<{ vector_count: number; vector_version: string; vector_cache_load_ms?: number }> {
  if (!request.vector_cache) {
    applyVectorMap(state, request);
    return { vector_count: state.vectors.size, vector_version: state.vectorVersion };
  }
  const ownerId = String(request.vector_cache.owner_id || "");
  assertWorkerOwner(ownerId);
  const vectorVersion = String(request.vector_cache.vector_version || "");
  const started = performance.now();
  const vectors = vectorVersion
    ? await loadDocumentVectors(ownerId, state.documents, vectorVersion, getStorageReader())
    : {};
  state.vectors = new Map(Object.entries(vectors));
  state.vectorVersion = vectorVersion;
  return {
    vector_count: state.vectors.size,
    vector_version: state.vectorVersion,
    vector_cache_load_ms: Math.round(performance.now() - started),
  };
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
    if (document && score > 0 && (!allowedSources.size || allowedSources.has(document.source_type)) && matchesScope(document, scope)) scored.push({ id, score, source_type: document.source_type, document_version: document.document_version, document });
  }
  return {
    results: scored
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
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

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16); }

async function handle(state: State, transient: State, request: RagRequest): Promise<RagResponse> {
  if (request.op === "database_revision") {
    assertWorkerOwner(request.owner_id);
    const revision = await getDataRuntime().getRagIndexRevision({ ownerId: request.owner_id });
    return { status: "ok", version: VERSION, revision };
  }
  if (request.op === "load_index_from_database") {
    const operationStarted = performance.now();
    const probe: WorkerProbe = { stage_ms: {}, counts: {} };
    assertWorkerOwner(request.owner_id);
    let stageStarted = performance.now();
    const result = await getDataRuntime().loadRagIndex({ ownerId: request.owner_id });
    for (const [name, elapsed] of Object.entries(result.probe.stage_ms)) {
      probe.stage_ms[`data_runtime_${name}`] = elapsed;
    }
    Object.assign(probe.counts, result.probe.counts);

    stageStarted = performance.now();
    replaceInMemory(state, request.revision, result.snapshot.documents);
    recordProbeStage(probe, "index_install_build", stageStarted);
    probe.counts.posting_terms = state.postings.size;

    const vectorVersion = String(request.vector_version || "");
    const vectorProbe = {
      stage_ms: {} as Record<string, number>,
      counts: {} as Record<string, number>,
      cache: { owner_cache_hit: false, scoped_cache_hit: false },
    };
    stageStarted = performance.now();
    const vectors = vectorVersion
      ? await loadDocumentVectors(
        request.owner_id, result.snapshot.documents, vectorVersion, getStorageReader(), vectorProbe,
      )
      : {};
    recordProbeStage(probe, "vector_cache_load", stageStarted);
    for (const [name, elapsed] of Object.entries(vectorProbe.stage_ms)) {
      probe.stage_ms[name] = elapsed;
    }
    Object.assign(probe.counts, vectorProbe.counts);
    state.vectors = new Map(Object.entries(vectors));
    state.vectorVersion = vectorVersion;
    state.restoreError = null;
    probe.counts.vector_count = state.vectors.size;
    await persist(state, probe);
    recordProbeStage(probe, "load_index_from_database_total", operationStarted);
    return {
      status: "ok", version: VERSION, revision: state.revision,
      document_count: state.documents.length,
      estimated_bytes: Buffer.byteLength(JSON.stringify(state.documents), "utf8"),
      vector_count: state.vectors.size,
      vector_version: state.vectorVersion,
      probe,
    };
  }
  if (request.op === "load_vectors_from_storage") {
    assertWorkerOwner(request.owner_id);
    const vectors = await loadDocumentVectors(
      request.owner_id, state.documents, String(request.vector_version || ""), getStorageReader(),
    );
    state.vectors = new Map(Object.entries(vectors));
    state.vectorVersion = String(request.vector_version || "");
    await persist(state);
    return {
      status: "ok", version: VERSION,
      vector_count: state.vectors.size,
      vector_version: state.vectorVersion,
    };
  }
  if (request.op === "prepare_memory") {
    const operationStarted = performance.now();
    assertWorkerOwner(request.owner_id);
    const prepared = await prepareMemory({
      ownerId: request.owner_id,
      scopes: request.scopes as AuthorizedMemoryScope[],
      sourceFilter: request.source_filter,
      snapshotRevision: String(request.snapshot_revision || ""),
      snapshotText: String(request.snapshot_text || ""),
      vectorVersion: String(request.vector_version || ""),
    }, getDataRuntime(), getStorageReader());
    const vectorVersion = String(request.vector_version || "");
    let stageStarted = performance.now();
    const transientRevision = digest({ documents: prepared.documents, vectorVersion });
    prepared.probe.stage_ms.transient_revision = Math.round(performance.now() - stageStarted);
    stageStarted = performance.now();
    replaceInMemory(transient, transientRevision, prepared.documents);
    transient.vectors = new Map(Object.entries(prepared.vectors));
    transient.vectorVersion = vectorVersion;
    prepared.probe.stage_ms.transient_index_install = Math.round(performance.now() - stageStarted);
    prepared.probe.stage_ms.prepare_memory_operation_total = Math.round(performance.now() - operationStarted);
    prepared.probe.counts.transient_document_count = transient.documents.length;
    prepared.probe.counts.transient_vector_count = transient.vectors.size;
    return {
      status: "ok", version: VERSION,
      transient_revision: transient.revision,
      document_count: transient.documents.length,
      vector_count: transient.vectors.size,
      vector_version: transient.vectorVersion,
      memory_source: prepared.indexSource,
      probe: prepared.probe,
    };
  }
  if (request.op === "set_vectors") {
    applyVectorMap(state, request);
    await persist(state);
    return {
      status: "ok", version: VERSION,
      vector_count: state.vectors.size,
      vector_version: state.vectorVersion,
    };
  }
  if (request.op === "replace_transient") {
    // Memory 快照语料：与持久化索引共存于同一 worker，各自保留 BM25 统计边界；
    // 只驻内存不落盘，worker 重启后由 Python 按快照指纹重传。
    replaceInMemory(transient, request.revision ?? "", request.documents ?? []);
    // 向量随语料驻留（指纹含模型版本戳，换模型必然重传）；未携带 = 本轮无向量。
    const vectors = (request as { vectors?: Record<string, number[]> }).vectors;
    transient.vectors = new Map(Object.entries(vectors ?? {}));
    transient.vectorVersion = String((request as { vector_version?: string }).vector_version ?? "");
    return { status: "ok", version: VERSION, revision: transient.revision, document_count: transient.documents.length };
  }
  if (request.op === "unified_query") {
    // Phase 5 统一查询：一次 IPC 完成 BM25 召回、来源聚合、水位过滤、Memory
    // 融合与 confidence 排序；Python 只保留权限复核与注入组装。
    const workerStarted = performance.now();
    const searches = Array.isArray(request.searches) ? request.searches : [];
    const hasTransient = searches.some((item) => item.corpus === "transient");
    if (request.revision !== state.revision) return { status: "error", code: "revision_mismatch", message: "TS 统一查询索引版本不一致" };
    if (hasTransient && (!(request.transient_revision ?? "") || request.transient_revision !== transient.revision)) {
      return { status: "error", code: "revision_mismatch", message: "TS 统一查询瞬态语料版本不一致" };
    }
    const stageMs: Record<string, number> = {};
    let stageStarted = performance.now();
    const terms = new Set(tokens(request.query));
    stageMs.query_tokenize = Math.round(performance.now() - stageStarted);
    stageStarted = performance.now();
    const persistentScores = scoreTerms(state, terms);
    const transientScores = hasTransient ? scoreTerms(transient, terms) : undefined;
    stageMs.bm25_scoring = Math.round(performance.now() - stageStarted);
    const candidateLimit = Math.max(1, Math.min(Number(request.candidate_limit ?? 20), 50));
    const sourceOrder = Array.isArray(request.source_order) ? request.source_order.map(String) : [];

    // 逐 spec 检索后按来源聚合：同来源跨 scope 去重保首见，(-score, id) 排序截断。
    const groupOrder: string[] = [];
    const groups = new Map<string, Array<{ key: string; score: number; document: Document }>>();
    stageStarted = performance.now();
    for (const item of searches) {
      const corpus = item.corpus === "transient" ? transient : state;
      const preparedScores = item.corpus === "transient" ? transientScores : persistentScores;
      const found = search(corpus, request.query, candidateLimit, new Set(item.source_types ?? []), item.scope, preparedScores, terms);
      for (const hit of found.results) {
        const source = hit.document.source_type;
        let group = groups.get(source);
        if (!group) {
          group = [];
          groups.set(source, group);
          groupOrder.push(source);
        }
        if (group.some((existing) => existing.key === hit.id)) continue;
        group.push({ key: hit.id, score: hit.score, document: hit.document });
      }
    }
    stageMs.lexical_search_and_group = Math.round(performance.now() - stageStarted);
    stageStarted = performance.now();
    const merged = new Map<string, Array<{ key: string; score: number; document: Document }>>();
    for (const [source, group] of groups) {
      const ordered = group
        .sort((left, right) => right.score - left.score || (left.key < right.key ? -1 : 1))
        .slice(0, candidateLimit);
      merged.set(source, ordered);
    }

    // conversation 消息水位：只过滤 kind === "message" 的文档（镜像 Python 语义）。
    const beforeMessageId = request.before_message_id;
    if (beforeMessageId !== undefined && beforeMessageId !== null) {
      for (const [source, group] of merged) {
        if (source !== "conversation") continue;
        merged.set(source, group.filter(({ document }) => {
          const metadata = document.metadata ?? {};
          if (String(metadata.kind ?? "") !== "message") return true;
          const raw = metadata.message_id;
          const value = Number(raw);
          return Number.isFinite(value) && value < beforeMessageId;
        }));
      }
    }
    stageMs.merge_and_watermark = Math.round(performance.now() - stageStarted);

    // 融合：Memory 组向量来自瞬态槽驻留（随语料上传），语义与 hybrid_fuse 冻结契约一致；
    // 其余持久来源组用 replace/patch 整表搭载的持久向量，且要求 Python 声明的
    // embedding 版本戳与驻留表一致——不一致（换模型窗口）时降级纯词法，宁缺勿错。
    const queryVector = Array.isArray(request.query_vector) ? request.query_vector : [];
    const lexicalWeight = Number(request.lexical_weight ?? 0.45);
    const vectorWeight = Number(request.vector_weight ?? 0.55);
    const rrfK = Number(request.rrf_k ?? 60);
    let fusion: { fusion: "hybrid-rrf" | "bm25"; vector_doc_count: number; vector_version: string; fallback: string | null } = {
      fusion: "bm25", vector_doc_count: 0, vector_version: transient.vectorVersion, fallback: "embedding_cache_unavailable",
    };
    let fusedAny = false;
    let memoryFused = false;
    let vectorDocCount = 0;
    let fusionVersion = transient.vectorVersion;
    // 候选池级语义分（原始余弦）：融合生效的组内每个向量命中都进池，
    // 供 v4 排序按 池最大值 归一化后以 0.45/0.55 混入词法位（镜像 Python
    // 诊断探针 apply_confidence_v4 的语义混合公式）。
    stageStarted = performance.now();
    const semanticCosines = new Map<string, number>();
    const memoryGroup = merged.get("memory");
    if (memoryGroup && memoryGroup.length && queryVector.length && transient.vectors.size) {
      const hits = memoryGroup.map((item) => ({ chunk_id: item.key }));
      const { fusedScores, vectorDocCount: memoryVectorDocs, vectorScores } = hybridFuseScores(
        hits, queryVector, transient.vectors, lexicalWeight, vectorWeight, rrfK);
      if (fusedScores.size) {
        merged.set("memory", memoryGroup.map((item) => ({
          ...item, score: fusedScores.get(item.key) ?? item.score,
        })));
        fusedAny = true;
        memoryFused = true;
        vectorDocCount += memoryVectorDocs;
        fusionVersion = transient.vectorVersion;
        for (const [key, cosine] of vectorScores) semanticCosines.set(key, cosine);
      }
    }
    const persistentVectorsUsable = queryVector.length > 0 && state.vectors.size > 0
      && String(request.vector_version ?? "") !== ""
      && state.vectorVersion === String(request.vector_version);
    if (persistentVectorsUsable) {
      for (const [source, group] of merged) {
        if (source === "memory" || group.length === 0) continue;
        const hits = group.map((item) => ({ chunk_id: item.key }));
        const { fusedScores, vectorDocCount: groupVectorDocs, vectorScores } = hybridFuseScores(
          hits, queryVector, state.vectors, lexicalWeight, vectorWeight, rrfK);
        if (!fusedScores.size) continue;
        merged.set(source, group.map((item) => ({
          ...item, score: fusedScores.get(item.key) ?? item.score,
        })));
        fusedAny = true;
        vectorDocCount += groupVectorDocs;
        if (!memoryFused) fusionVersion = state.vectorVersion;
        for (const [key, cosine] of vectorScores) semanticCosines.set(key, cosine);
      }
    }
    if (fusedAny) {
      fusion = { fusion: "hybrid-rrf", vector_doc_count: vectorDocCount, vector_version: fusionVersion, fallback: null };
    }
    stageMs.vector_fusion = Math.round(performance.now() - stageStarted);

    // 候选打包镜像 Python rank_candidates_with_cache 的 payload（含平铺顺序）。
    stageStarted = performance.now();
    const orderedSources = [
      ...sourceOrder.filter((source) => merged.has(source)),
      ...groupOrder.filter((source) => !sourceOrder.includes(source)),
    ];
    const payload: import("../../../packages/contracts/src/rag.ts").RagRankCandidate[] = [];
    const keysByCandidateId = new Map<string, string>();
    for (const source of orderedSources) {
      for (const item of merged.get(source)!) {
        const candidateId = `${source}:${item.key}:${payload.length}`;
        keysByCandidateId.set(candidateId, item.key);
        const semanticScore = semanticCosines.get(item.key);
        payload.push({
          id: candidateId,
          source_type: source,
          raw_score: item.score,
          fusion: "bm25",
          fused_score: null,
          ...(semanticScore !== undefined ? { semantic_score: semanticScore } : {}),
          document: { ...item.document, id: candidateId },
        });
      }
    }
    stageMs.candidate_pack = Math.round(performance.now() - stageStarted);
    const rankOptions = (request.rank ?? {}) as NonNullable<typeof request.rank>;
    const rankingStatistics = hasTransient
      ? mergeCorpusStatistics([state, transient])
      : corpusStatistics(state);
    stageStarted = performance.now();
    const ranked = rankCandidates(request.query, payload, {
      limit: Number(rankOptions.limit ?? 5),
      maxChars: Number(rankOptions.max_chars ?? 3000),
      maxPerSource: Number(rankOptions.max_per_source ?? 3),
      maxPerParent: Number(rankOptions.max_per_parent ?? 3),
      excludeContentHashes: rankOptions.exclude_content_hashes ?? [],
      selectionMode: rankOptions.selection_mode ?? "confidence",
      corpusStatistics: rankingStatistics,
    });
    stageMs.rank_and_idf_rescore = Math.round(performance.now() - stageStarted);
    stageStarted = performance.now();
    const document_counts: Record<string, number> = {};
    for (const corpus of [state, transient]) {
      for (const document of corpus.documents) {
        document_counts[document.source_type] = (document_counts[document.source_type] ?? 0) + 1;
      }
    }
    const source_groups: Record<string, { candidate_count: number; hit_count: number }> = {};
    for (const [source, group] of merged) {
      source_groups[source] = { candidate_count: group.length, hit_count: group.length };
    }
    stageMs.response_assembly = Math.round(performance.now() - stageStarted);
    stageMs.worker_total = Math.round(performance.now() - workerStarted);
    return {
      status: "ok", version: VERSION, revision: state.revision,
      selected: ranked.results.map((row) => ({
        ...row,
        document_key: keysByCandidateId.get(row.id) ?? "",
        document: (() => {
          const key = keysByCandidateId.get(row.id) ?? "";
          return state.documentsById.get(key) ?? transient.documentsById.get(key);
        })(),
        raw_score: Number(payload.find((candidate) => candidate.id === row.id)?.raw_score ?? 0),
      })),
      stats: ranked.diagnostics,
      fusion, document_counts, source_groups,
      probe: {
        stage_ms: stageMs,
        counts: {
          persistent_documents: state.documents.length,
          transient_documents: hasTransient ? transient.documents.length : 0,
          search_specs: searches.length,
          candidate_pool: payload.length,
          selected: ranked.results.length,
          source_groups: merged.size,
        },
      },
    };
  }
  if (request.op === "batch_search") {
    // 每个语料槽各自校验 revision：瞬态语料由 Python 在请求里带上快照指纹；
    // 空指纹视为瞬态语料未装载（worker 重启后 Python 必须先重传再查询）。
    const hasTransient = request.searches.some((item) => item.corpus === "transient");
    if (request.revision !== state.revision) return { status: "error", code: "revision_mismatch", message: "TS 批量查询索引版本不一致" };
    if (hasTransient && (!(request.transient_revision ?? "") || request.transient_revision !== transient.revision)) {
      return { status: "error", code: "revision_mismatch", message: "TS 批量查询瞬态语料版本不一致" };
    }
    if (new Set(request.searches.map((item) => item.id)).size !== request.searches.length) {
      return { status: "error", code: "duplicate_search_id", message: "批量查询标识重复" };
    }
    // 全语料只分词一次；BM25 统计按语料槽各自计算一次，不合并语料。
    const terms = new Set(tokens(request.query));
    const persistentScores = scoreTerms(state, terms);
    const transientScores = hasTransient ? scoreTerms(transient, terms) : undefined;
    const document_counts: Record<string, number> = {};
    for (const corpus of [state, transient]) {
      for (const document of corpus.documents) {
        document_counts[document.source_type] = (document_counts[document.source_type] ?? 0) + 1;
      }
    }
    return {
      status: "ok", version: VERSION, revision: state.revision, document_counts,
      batches: request.searches.map((item) => {
        const corpus = item.corpus === "transient" ? transient : state;
        const preparedScores = item.corpus === "transient" ? transientScores : persistentScores;
        return { id: item.id,
          ...search(corpus, request.query, item.limit ?? 10, new Set(item.source_types ?? []), item.scope, preparedScores, terms) };
      }),
    };
  }
  if (request.op === "hybrid_fuse") {
    // 与 Python hybrid_results 逐位等价：余弦累加顺序、RRF 乘法顺序、
    // 排序 tie-break 和透传语义完全一致（Phase 3 契约冻结）。
    const hits = Array.isArray(request.hits) ? request.hits : [];
    const queryVector = Array.isArray(request.query_vector) ? request.query_vector : [];
    const vectors = request.vectors ?? {};
    const limit = Math.max(1, Math.min(Number(request.limit ?? 20), 200));
    const lexicalWeight = Number(request.lexical_weight ?? 0.45);
    const vectorWeight = Number(request.vector_weight ?? 0.55);
    const rrfK = Number(request.rrf_k ?? 60);
    const passthrough = (fusion: "hybrid-rrf" | "bm25", count: number, fallback: string | null,
      rows: Array<{ chunk_id: string; score: number }>) => ({
      status: "ok" as const, version: VERSION, fusion,
      vector_doc_count: count, vector_version: String(request.vector_version ?? ""),
      fallback, results: rows,
    });
    if (!queryVector.length || Object.keys(vectors).length === 0) {
      return passthrough("bm25", 0, "embedding_cache_unavailable",
        hits.slice(0, limit).map((hit) => ({ chunk_id: String(hit.chunk_id), score: Number(hit.score || 0) })));
    }
    const rrf = (rank: number, weight: number) => weight * ((rrfK + 1) / (rrfK + Math.max(1, rank)));
    const { fusedScores, vectorDocCount } = hybridFuseScores(hits, queryVector, vectors, lexicalWeight, vectorWeight, rrfK);
    if (fusedScores.size === 0) {
      // Python 在 vector_map 非空但命中都没有可用向量时，仍按纯词法 RRF 重打分
      // 再按 (-score, chunk_id) 排序，不是透传原始分。
      const lexicalOnly = hits.map((hit, index) => ({
        chunk_id: String(hit.chunk_id), score: rrf(index + 1, lexicalWeight),
      }));
      lexicalOnly.sort((left, right) => right.score - left.score || (left.chunk_id < right.chunk_id ? -1 : 1));
      return passthrough("bm25", 0, "embedding_cache_unavailable", lexicalOnly.slice(0, limit));
    }
    const scored = hits.map((hit) => ({ chunk_id: String(hit.chunk_id), score: fusedScores.get(String(hit.chunk_id))! }));
    scored.sort((left, right) => right.score - left.score || (left.chunk_id < right.chunk_id ? -1 : 1));
    return passthrough("hybrid-rrf", vectorDocCount, null, scored.slice(0, limit));
  }
  if (request.op === "ping") {
    return {
      status: "ok", version: VERSION, revision: state.revision,
      document_count: state.documents.length, restore_error: state.restoreError,
      vector_version: state.vectorVersion, restore_probe: state.restoreProbe,
    };
  }
  if (request.op === "tokenize") return { status: "ok", version: VERSION, tokens: tokenizeRaw(String(request.text ?? "")) };
  if (request.op === "adapt") {
    const batchKey = request.source_type === "file"
      ? "files"
      : request.source_type === "conversation"
        ? "conversations"
        : request.source_type;
    const batch = { [batchKey]: request.records } as RagSourceBatch;
    const documents = buildSourceDocuments(batch);
    return { status: "ok", version: VERSION, documents, document_count: documents.length };
  }
  if (request.op === "build_documents") {
    const documents = buildSourceDocuments(request.batch as unknown as RagSourceBatch);
    return { status: "ok", version: VERSION, documents, document_count: documents.length };
  }
  if (request.op === "build_and_index") {
    const documents = buildSourceDocuments(request.batch as unknown as RagSourceBatch);
    state.restoreError = null;
    replaceInMemory(state, request.revision, documents);
    await persist(state);
    return {
      status: "ok", version: VERSION, revision: state.revision,
      document_count: documents.length, input_digest: digest(documents),
    };
  }
  if (request.op === "replace") {
    validateStoredVectorOwner(request);
    replaceInMemory(state, request.revision ?? "", request.documents ?? []);
    const vectors = await applyStoredVectorCache(state, request);
    state.restoreError = null;
    await persist(state);
    return {
      status: "ok", version: VERSION, revision: state.revision,
      document_count: state.documents.length, ...vectors,
    };
  }
  if (request.op === "patch") {
    if ((request.base_revision ?? "") !== state.revision && request.base_revision !== undefined) {
      return { status: "error", code: "revision_mismatch", message: "TS worker patch 基线 revision 与当前索引不一致" };
    }
    validateStoredVectorOwner(request);
    patchInMemory(state, request.revision ?? "", request.upserts ?? [], request.deletes ?? []);
    const vectors = await applyStoredVectorCache(state, request);
    await persist(state);
    return {
      status: "ok", version: VERSION, revision: state.revision,
      document_count: state.documents.length, ...vectors,
    };
  }
  if (request.op === "search") {
    if ((request.revision ?? "") !== state.revision) return { status: "error", code: "revision_mismatch", message: "TS sidecar revision 与请求不一致" };
    const allowedSources = new Set(request.source_types ?? []);
    const result = search(state, request.query ?? "", request.limit ?? 10, allowedSources, request.scope);
    return { status: "ok", version: VERSION, revision: state.revision, ...result };
  }
  if (request.op === "unified_search") {
    if ((request.revision ?? "") !== state.revision) return { status: "error", code: "revision_mismatch", message: "TS sidecar revision 与请求不一致" };
    const allowedSources = new Set(request.source_types ?? []);
    const searched = search(state, request.query ?? "", 50, allowedSources, request.scope);
    const documentsById = new Map(state.documents.map((document) => [document.id, document]));
    const candidates: RagRankCandidate[] = searched.results.flatMap((result) => {
      const document = documentsById.get(result.id);
      return document ? [{
        id: result.id,
        source_type: document.source_type,
        raw_score: result.score,
        fusion: "bm25" as const,
        fused_score: null,
        document,
      }] : [];
    });
    const ranked = rankCandidates(request.query ?? "", candidates, {
      limit: request.limit ?? 5,
      maxChars: request.max_chars ?? 3000,
      selectionMode: "top_k",
      corpusStatistics: corpusStatistics(state),
    });
    const results = ranked.results.flatMap((result) => {
      const document = documentsById.get(result.id);
      return document ? [{ ...document, text: result.text }] : [];
    });
    return { status: "ok", version: VERSION, revision: state.revision, results, has_more: candidates.length > results.length, diagnostics: ranked.diagnostics };
  }
  if (request.op === "rank_candidates") {
    const diagnosticCorpus = Array.isArray(request.corpus_documents)
      ? makeState()
      : null;
    if (diagnosticCorpus) {
      replaceInMemory(diagnosticCorpus, "diagnostic", request.corpus_documents ?? []);
    }
    const output = rankCandidates(
      request.query ?? "",
      (request.candidates ?? []) as RagRankCandidate[],
      {
        limit: request.limit ?? 5,
        maxChars: request.max_chars ?? 3000,
        maxPerSource: request.max_per_source ?? 3,
        maxPerParent: request.max_per_parent ?? 3,
        excludeContentHashes: request.exclude_content_hashes ?? [],
        selectionMode: request.selection_mode ?? "confidence",
        scoringVersion: request.scoring_version ?? "confidence-v4",
        corpusStatistics: diagnosticCorpus
          ? corpusStatistics(diagnosticCorpus)
          : corpusStatistics(state),
      },
    );
    return {
      status: "ok",
      version: VERSION,
      selected: output.results,
      stats: output.diagnostics,
      input_digest: digest(request.candidates ?? []),
    };
  }
  return { status: "error", code: "unknown_operation", message: "未知操作" };
}

const args = process.argv.slice(2);
if (args.includes("--version")) { console.log(`gugu-rag-ts-worker ${VERSION}`); process.exit(0); }
const indexDir = args[0];
const state = makeState(indexDir);
const transient = makeState();
await restore(state);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let response: RagResponse;
  try { response = await handle(state, transient, JSON.parse(line)); }
  catch (error) { response = { status: "error", code: "worker_failure", message: error instanceof Error ? error.message : "worker failure" }; }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
await dataRuntime?.close();
