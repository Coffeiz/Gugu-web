import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  RagDocument,
  RagRequest,
  RagResponse,
  RagScoreCandidate,
  RagScoreStats,
  RagSearchScope,
  RagSearchResult,
} from "../../../packages/contracts/src/rag.ts";
import { RAG_WORKER_VERSION } from "../../../packages/contracts/src/rag.ts";
import { tokenizeRaw } from "./tokenizer.ts";

const VERSION = RAG_WORKER_VERSION;
const K1 = 1.2;
const B = 0.75;
const HARD_FLOOR = 0.35;
const PREFERRED = 0.55;
const SCORING_VERSION = "confidence-v1";
const SOURCE_QUALITY: Record<string, number> = {
  memory: 0.8, project: 0.9, file: 0.8, canvas: 0.75,
  conversation: 0.65, journal: 0.7, knowledge: 0.8,
};

type Document = RagDocument;

type State = { revision: string; documents: Document[]; index: Map<string, number>[]; docFreq: Map<string, number>; avgLength: number; totalLength: number; indexDir?: string };

function tokens(value: string): string[] {
  return tokenizeRaw(value);
}

function termFrequency(items: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(item, (out.get(item) ?? 0) + 1);
  return out;
}

function makeState(indexDir?: string): State {
  return { revision: "", documents: [], index: [], docFreq: new Map(), avgLength: 0, totalLength: 0, indexDir };
}

async function restore(state: State): Promise<void> {
  if (!state.indexDir) return;
  try {
    const raw = JSON.parse(await readFile(join(state.indexDir, "index.json"), "utf8"));
    replaceInMemory(state, raw.revision ?? "", raw.documents ?? []);
  } catch {
    // 空目录或旧版本索引由上层 replace；不能把恢复失败伪装成有数据。
    state.revision = "";
  }
}

function replaceInMemory(state: State, revision: string, documents: Document[]): void {
  state.revision = revision;
  state.documents = documents;
  state.index = [];
  state.docFreq = new Map();
  let total = 0;
  for (const document of documents) {
    const frequency = termFrequency(tokens(document.text));
    state.index.push(frequency);
    total += [...frequency.values()].reduce((sum, value) => sum + value, 0);
    for (const term of frequency.keys()) state.docFreq.set(term, (state.docFreq.get(term) ?? 0) + 1);
  }
  state.avgLength = documents.length ? total / documents.length : 0;
  state.totalLength = total;
}

function patchInMemory(state: State, revision: string, upserts: Document[], deletes: string[]): void {
  const removeAt = (position: number): void => {
    const frequency = state.index[position];
    const length = [...frequency.values()].reduce((sum, value) => sum + value, 0);
    state.totalLength -= length;
    for (const term of frequency.keys()) {
      const count = (state.docFreq.get(term) ?? 0) - 1;
      if (count > 0) state.docFreq.set(term, count);
      else state.docFreq.delete(term);
    }
    state.documents.splice(position, 1);
    state.index.splice(position, 1);
  };
  const positions = new Map(state.documents.map((document, index) => [document.id, index]));
  for (const id of deletes) {
    const position = positions.get(id);
    if (position === undefined) continue;
    removeAt(position);
    positions.clear();
    state.documents.forEach((document, index) => positions.set(document.id, index));
  }
  for (const document of upserts) {
    const position = positions.get(document.id);
    if (position !== undefined) removeAt(position);
    const frequency = termFrequency(tokens(document.text));
    const length = [...frequency.values()].reduce((sum, value) => sum + value, 0);
    state.documents.push(document);
    state.index.push(frequency);
    state.totalLength += length;
    for (const term of frequency.keys()) state.docFreq.set(term, (state.docFreq.get(term) ?? 0) + 1);
    positions.clear();
    state.documents.forEach((item, index) => positions.set(item.id, index));
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
  for (const key of ["platform", "bot_id", "group_id", "scope_type", "scope_id"] as const) {
    const wanted = scope[key];
    if (wanted && document[key] !== wanted) return false;
  }
  return true;
}

function search(state: State, query: string, limit: number, allowedSources: Set<string>, scope?: RagSearchScope): RagSearchResult[] {
  const terms = new Set(tokens(query));
  if (!terms.size) return [];
  const total = state.documents.length;
  const scored: RagSearchResult[] = [];
  state.documents.forEach((document, index) => {
    if ((allowedSources.size && !allowedSources.has(document.source_type)) || !matchesScope(document, scope)) return;
    const frequency = state.index[index];
    const length = Math.max(1, [...frequency.values()].reduce((sum, value) => sum + value, 0));
    let score = 0;
    for (const term of terms) {
      const tf = frequency.get(term) ?? 0;
      if (!tf) continue;
      const df = state.docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      const norm = tf + K1 * (1 - B + B * length / (state.avgLength || 1));
      score += idf * tf * (K1 + 1) / norm;
    }
    if (score > 0) scored.push({ id: document.id, score, source_type: document.source_type, document_version: document.document_version });
  });
  return scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, Math.max(1, Math.min(limit, 50)));
}

function queryMatch(query: string, candidate: any): number {
  const queryTokens = new Set(tokens(query).filter((item) => !/^[\d\p{P}\p{S}_]+$/u.test(item)));
  if (!queryTokens.size) return 0;
  const text = `${candidate.title ?? ""}\n${candidate.summary ?? ""}\n${candidate.content ?? ""}`;
  const compactQuery = query.replace(/\s+/gu, "").toLocaleLowerCase();
  const compactText = text.replace(/\s+/gu, "").toLocaleLowerCase();
  if (compactQuery.length >= 2 && compactText.includes(compactQuery)) return 1;
  const documentTokens = new Set(tokens(text));
  let matches = 0;
  for (const item of queryTokens) if (documentTokens.has(item)) matches += 1;
  return matches / queryTokens.size;
}

function scoreFilter(query: string, candidates: RagScoreCandidate[], limit: number): { selected: RagScoreCandidate[]; stats: RagScoreStats } {
  const scored = candidates.map((candidate) => {
    let sourceQuality = SOURCE_QUALITY[candidate.source_type] ?? 0.7;
    if (candidate.source_type === "knowledge") {
      const weight = { confirmed: 1, probable: 0.85, unverified: 0.65, conflict: 0.35 }[candidate.confidence as string] ?? 0.65;
      sourceQuality *= weight;
    }
    const match = Math.min(1, queryMatch(query, candidate));
    const fused = Number(candidate.fused_score || candidate.normalized_score || 0);
    let confidence = 0.55 * fused + 0.25 * match + 0.20 * sourceQuality;
    if (match <= 0) confidence = Math.min(confidence, HARD_FLOOR - 0.01);
    return { ...candidate, confidence: Math.min(1, Math.max(0, confidence)), source_quality: sourceQuality };
  });
  const preferred = scored.filter((item) => item.confidence >= PREFERRED);
  const fallback = scored.filter((item) => item.confidence >= HARD_FLOOR && item.confidence < PREFERRED);
  const selected = (preferred.length ? preferred : fallback).slice(0, Math.max(1, Number(limit)));
  const selectedIds = new Set(selected.map((item) => item.id));
  return {
    selected,
    stats: {
      accepted_count: selected.length,
      rejected_low_score: scored.filter((item) => item.confidence < HARD_FLOOR).length,
      rejected_not_preferred: scored.filter((item) => preferred.length > 0 && item.confidence >= HARD_FLOOR && !selectedIds.has(item.id)).length,
      top_confidence: Math.max(0, ...scored.map((item) => item.confidence)),
      threshold: HARD_FLOOR,
      preferred_threshold: PREFERRED,
      scoring_version: SCORING_VERSION,
    },
  };
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16); }

async function handle(state: State, request: RagRequest): Promise<RagResponse> {
  if (request.op === "ping") return { status: "ok", version: VERSION, revision: state.revision, document_count: state.documents.length };
  if (request.op === "tokenize") return { status: "ok", version: VERSION, tokens: tokenizeRaw(String(request.text ?? "")) };
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
    return { status: "ok", version: VERSION, revision: state.revision, results: result };
  }
  if (request.op === "score_filter") {
    const output = scoreFilter(request.query, request.candidates, request.limit ?? 10);
    return { status: "ok", version: VERSION, selected: output.selected, stats: output.stats, input_digest: digest(request.candidates ?? []) };
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
