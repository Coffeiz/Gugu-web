import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  RagDocument,
  RagRankCandidate,
  RagRequest,
  RagResponse,
  RagSearchDiagnostics,
  RagSearchScope,
  RagSearchResult,
} from "../../../packages/contracts/src/rag.ts";
import { RAG_WORKER_VERSION } from "../../../packages/contracts/src/rag.ts";
import { tokenizeRaw } from "./tokenizer.ts";
import { buildSourceDocuments, type RagSourceBatch } from "./index-builder.ts";
import { rankCandidates, selectUnifiedRecall } from "./service.ts";

const VERSION = RAG_WORKER_VERSION;
const K1 = 1.2;
const B = 0.75;

type Document = RagDocument;

type Posting = { ids: string[]; frequencies: number[] };
type State = {
  revision: string;
  restoreError: string | null;
  documents: Document[];
  documentsById: Map<string, Document>;
  postings: Map<string, Posting>;
  lengths: Map<string, number>;
  docFreq: Map<string, number>;
  avgLength: number;
  totalLength: number;
  indexDir?: string;
};

function tokens(value: string): string[] {
  return tokenizeRaw(value);
}

function termFrequency(items: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(item, (out.get(item) ?? 0) + 1);
  return out;
}

function makeState(indexDir?: string): State {
  return {
    revision: "", restoreError: null, documents: [], documentsById: new Map(), postings: new Map(),
    lengths: new Map(), docFreq: new Map(), avgLength: 0, totalLength: 0, indexDir,
  };
}

async function restore(state: State): Promise<void> {
  if (!state.indexDir) return;
  let raw: string;
  try {
    raw = await readFile(join(state.indexDir, "index.json"), "utf8");
  } catch {
    // 首次冷启动没有索引文件，不属于损坏。
    return;
  }
  // 恢复失败由上层 replace 重建；结局必须显式可观测，不能伪装成有数据或无声跳过。
  try {
    const parsed = JSON.parse(raw) as { version?: string; revision?: string; documents?: Document[] };
    if (parsed.version !== VERSION) {
      state.restoreError = "version_mismatch";
      return;
    }
    replaceInMemory(state, parsed.revision ?? "", parsed.documents ?? []);
  } catch {
    state.restoreError = "corrupt";
  }
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
  const frequency = termFrequency(tokens(document.text));
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
  const frequency = termFrequency(tokens(document.text));
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

async function persist(state: State): Promise<void> {
  if (!state.indexDir) return;
  await mkdir(state.indexDir, { recursive: true, mode: 0o700 });
  const target = join(state.indexDir, "index.json");
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: VERSION, revision: state.revision, documents: state.documents }), { mode: 0o600 });
  await rename(temporary, target);
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

function scoreTerms(state: State, terms: Set<string>): Map<string, number> {
  const scores = new Map<string, number>();
  for (const term of terms) {
    const posting = state.postings.get(term);
    if (!posting) continue;
    const idf = Math.log(1 + (state.documents.length - posting.ids.length + 0.5) / (posting.ids.length + 0.5));
    posting.ids.forEach((id, position) => {
      const tf = posting.frequencies[position];
      const length = Math.max(1, state.lengths.get(id) ?? 0);
      const norm = tf + K1 * (1 - B + B * length / (state.avgLength || 1));
      scores.set(id, (scores.get(id) ?? 0) + idf * tf * (K1 + 1) / norm);
    });
  }
  return scores;
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
  if (request.op === "replace_transient") {
    // Memory 快照语料：与持久化索引共存于同一 worker，各自保留 BM25 统计边界；
    // 只驻内存不落盘，worker 重启后由 Python 按快照指纹重传。
    replaceInMemory(transient, request.revision ?? "", request.documents ?? []);
    return { status: "ok", version: VERSION, revision: transient.revision, document_count: transient.documents.length };
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
    const vectorScores = new Map<string, number>();
    for (const hit of hits) {
      const vector = vectors[String(hit.chunk_id)];
      // Python 只把 vector_map 里有非空向量的候选算进 vector_scores；
      // 维度不匹配（换过模型的脏数据）或零向量 → 0.0，但保留向量名次。
      if (!Array.isArray(vector) || vector.length === 0) continue;
      if (queryVector.length !== vector.length) {
        vectorScores.set(String(hit.chunk_id), 0);
        continue;
      }
      let dot = 0, na = 0, nb = 0;
      for (let index = 0; index < queryVector.length; index += 1) {
        dot += queryVector[index] * vector[index];
        na += queryVector[index] * queryVector[index];
        nb += vector[index] * vector[index];
      }
      vectorScores.set(String(hit.chunk_id), na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb)));
    }
    const rrf = (rank: number, weight: number) => weight * ((rrfK + 1) / (rrfK + Math.max(1, rank)));
    if (vectorScores.size === 0) {
      // Python 在 vector_map 非空但命中都没有可用向量时，仍按纯词法 RRF 重打分
      // 再按 (-score, chunk_id) 排序，不是透传原始分。
      const lexicalOnly = hits.map((hit, index) => ({
        chunk_id: String(hit.chunk_id), score: rrf(index + 1, lexicalWeight),
      }));
      lexicalOnly.sort((left, right) => right.score - left.score || (left.chunk_id < right.chunk_id ? -1 : 1));
      return passthrough("bm25", 0, "embedding_cache_unavailable", lexicalOnly.slice(0, limit));
    }
    const vectorRanked = [...vectorScores.keys()].sort((left, right) =>
      vectorScores.get(right)! - vectorScores.get(left)! || (left < right ? -1 : 1));
    const vectorRanks = new Map(vectorRanked.map((key, index) => [key, index + 1]));
    const scored = hits.map((hit, index) => {
      const key = String(hit.chunk_id);
      let score = rrf(index + 1, lexicalWeight);
      const vectorRank = vectorRanks.get(key);
      if (vectorRank !== undefined) score += rrf(vectorRank, vectorWeight);
      return { chunk_id: key, score };
    });
    scored.sort((left, right) => right.score - left.score || (left.chunk_id < right.chunk_id ? -1 : 1));
    return passthrough("hybrid-rrf", vectorScores.size, null, scored.slice(0, limit));
  }
  if (request.op === "ping") {
    return {
      status: "ok", version: VERSION, revision: state.revision,
      document_count: state.documents.length, restore_error: state.restoreError,
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
    replaceInMemory(state, request.revision ?? "", request.documents ?? []);
    state.restoreError = null;
    await persist(state);
    return { status: "ok", version: VERSION, revision: state.revision, document_count: state.documents.length };
  }
  if (request.op === "patch") {
    if ((request.base_revision ?? "") !== state.revision && request.base_revision !== undefined) {
      return { status: "error", code: "revision_mismatch", message: "TS worker patch 基线 revision 与当前索引不一致" };
    }
    patchInMemory(state, request.revision ?? "", request.upserts ?? [], request.deletes ?? []);
    await persist(state);
    return { status: "ok", version: VERSION, revision: state.revision, document_count: state.documents.length };
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
    const output = selectUnifiedRecall(
      searched.results.flatMap((result) => {
        const document = documentsById.get(result.id);
        return document ? [{ result, document }] : [];
      }),
      { limit: request.limit ?? 5, maxChars: request.max_chars ?? 3000 },
    );
    return { status: "ok", version: VERSION, revision: state.revision, ...output };
  }
  if (request.op === "rank_candidates") {
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
