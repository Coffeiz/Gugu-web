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
    revision: "", documents: [], documentsById: new Map(), postings: new Map(),
    lengths: new Map(), docFreq: new Map(), avgLength: 0, totalLength: 0, indexDir,
  };
}

async function restore(state: State): Promise<void> {
  if (!state.indexDir) return;
  try {
    const raw = JSON.parse(await readFile(join(state.indexDir, "index.json"), "utf8"));
    if (raw.version !== VERSION) return;
    replaceInMemory(state, raw.revision ?? "", raw.documents ?? []);
  } catch {
    // 空目录或旧版本索引由上层 replace；不能把恢复失败伪装成有数据。
    state.revision = "";
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

function search(
  state: State,
  query: string,
  limit: number,
  allowedSources: Set<string>,
  scope?: RagSearchScope,
): { results: RagSearchResult[]; diagnostics: RagSearchDiagnostics } {
  const started = performance.now();
  const terms = new Set(tokens(query));
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
  const total = state.documents.length;
  const scored: RagSearchResult[] = [];
  let eligibleCount = 0;
  state.documents.forEach((document) => {
    if ((allowedSources.size && !allowedSources.has(document.source_type)) || !matchesScope(document, scope)) return;
    eligibleCount += 1;
  });
  const scores = new Map<string, number>();
  for (const term of terms) {
    const posting = state.postings.get(term);
    if (!posting) continue;
    const df = posting.ids.length;
    const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
    posting.ids.forEach((id, position) => {
      const document = state.documentsById.get(id);
      if (!document || (allowedSources.size && !allowedSources.has(document.source_type)) || !matchesScope(document, scope)) return;
      const tf = posting.frequencies[position];
      const length = Math.max(1, state.lengths.get(id) ?? 0);
      const norm = tf + K1 * (1 - B + B * length / (state.avgLength || 1));
      scores.set(id, (scores.get(id) ?? 0) + idf * tf * (K1 + 1) / norm);
    });
  }
  for (const [id, score] of scores) {
    const document = state.documentsById.get(id);
    if (document && score > 0) scored.push({ id, score, source_type: document.source_type, document_version: document.document_version, document });
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

async function handle(state: State, request: RagRequest): Promise<RagResponse> {
  if (request.op === "ping") return { status: "ok", version: VERSION, revision: state.revision, document_count: state.documents.length };
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
    replaceInMemory(state, request.revision, documents);
    await persist(state);
    return {
      status: "ok", version: VERSION, revision: state.revision,
      document_count: documents.length, input_digest: digest(documents),
    };
  }
  if (request.op === "replace") {
    replaceInMemory(state, request.revision ?? "", request.documents ?? []);
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
await restore(state);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let response: RagResponse;
  try { response = await handle(state, JSON.parse(line)); }
  catch (error) { response = { status: "error", code: "worker_failure", message: error instanceof Error ? error.message : "worker failure" }; }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
