#!/usr/bin/env node
/**
 * Devserver RAG 三阶段 Python/TS A/B 基准。
 *
 * 只读真实业务数据，索引 worker 一律使用独立临时目录；Memory 对照路径会禁用
 * PersistentMemoryIndex.replace，避免在缓存缺失时写回真实用户存储。输出只含耗时、
 * 数量和错误类别，不输出 owner、正文、标题、路径或凭据。
 *
 * 运行必须显式提供 --allow-real-data；数据库 URL / Storage 根目录经环境变量传入。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import type { RagDocument, RagSourceRecord } from "../packages/contracts/src/rag.ts";
import { DataRuntime } from "../packages/data-runtime/src/runtime.ts";
import { createPostgresClient } from "../packages/data-runtime/src/postgres.ts";
import { loadMemoryCached } from "../packages/data-runtime/src/rag-loader.ts";
import { buildSourceDocuments } from "../workers/rag/src/index-builder.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "../..");
const workerArtifact = join(backendDir, "bin", "gugu-rag-ts-worker.mjs");
const PYTHON_BASELINE = String.raw`
import asyncio, hashlib, json, os, shutil, statistics, sys, tempfile, time
from pathlib import Path
from uuid import UUID

owner = UUID(sys.argv[1])
rounds = int(sys.argv[2])
tmp_roots = []

def stats(values):
    return round(statistics.median(values), 2) if values else None

def memory_signatures(documents):
    rows = []
    for document in documents:
        key = [document.source_type, document.source_id,
               document.parent_document_id or document.document_id, document.chunk_index]
        rows.append((key, [document.version, document.chunk_count],
                     [document.title, document.summary, document.content],
                     [document.scope.scope_type, document.scope.scope_id,
                      document.scope.platform, document.scope.bot_id, document.scope.group_id]))
    rows.sort(key=lambda row: f"{row[0][0]}|{row[0][2]}|{row[0][3]}")
    def digest(values):
        payload = json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()
    return {
        "identity": digest([row[0] for row in rows]),
        "version": digest([[row[0], row[1]] for row in rows]),
        "text": digest([[row[0], row[2]] for row in rows]),
        "scope": digest([[row[0], row[3]] for row in rows]),
    }

async def main():
    from app.db.session import dispose_engine, get_db
    from app.core.config import get_settings
    from agent.rag.index_cache import KnowledgeIndexCache
    import agent.rag.index_cache as index_cache_module
    from agent.rag.ts_sidecar import TsSidecarClient, close_lexical_clients
    from agent.rag.models import Scope
    from agent.rag.service import _memory_recall_documents
    from agent.rag.storage import PersistentMemoryIndex
    from app.services.storage import get_storage

    replace_ms = []
    index_get_ms = []
    doc_counts = []
    original_replace = TsSidecarClient.replace
    async def measured_replace(self, *args, **kwargs):
        started = time.perf_counter()
        try:
            return await original_replace(self, *args, **kwargs)
        finally:
            replace_ms.append((time.perf_counter() - started) * 1000)
    TsSidecarClient.replace = measured_replace

    original_memory_replace = PersistentMemoryIndex.replace
    async def no_storage_write(self, documents):
        return None
    PersistentMemoryIndex.replace = no_storage_write
    storage_type = type(get_storage())
    original_storage_put = storage_type.put
    async def no_storage_put(self, *args, **kwargs):
        raise RuntimeError("benchmark_storage_write_blocked")
    storage_type.put = no_storage_put

    try:
        for index in range(rounds):
            root = Path(tempfile.mkdtemp(prefix="gugu-rag-three-stage-ab-py-"))
            tmp_roots.append(root)
            index_cache_module.index_dir_for_owner = lambda _owner, path=root: str(path / "index")
            cache = KnowledgeIndexCache(owner_limit_bytes=2**40, global_limit_bytes=2**41)
            diagnostics = {}
            started = time.perf_counter()
            async for db in get_db():
                result = await cache.get(
                    db, owner, "knowledge", scope=Scope(owner_user_id=str(owner), scope_type="owner"),
                    diagnostics=diagnostics, force=True,
                )
                doc_counts.append(int(getattr(result, "document_count", len(getattr(result, "documents", ()) or ()))))
                break
            index_get_ms.append((time.perf_counter() - started) * 1000)
            cache.clear()
            await close_lexical_clients()

        memory_started = time.perf_counter()
        documents, _source, _load_ms = await _memory_recall_documents(
            str(owner), Scope(owner_user_id=str(owner), scope_type="owner"), "all",
        )
        memory_ms = (time.perf_counter() - memory_started) * 1000
        memory_count = len(documents)
        await close_lexical_clients()
        print(json.dumps({
            "index_cache_get_ms": stats(index_get_ms),
            "replace_ms": stats(replace_ms),
            "memory_load_ms": round(memory_ms, 2),
            "index_document_count": doc_counts[-1] if doc_counts else 0,
            "memory_document_count": memory_count,
            "memory_signatures": memory_signatures(documents),
        }))
    finally:
        TsSidecarClient.replace = original_replace
        PersistentMemoryIndex.replace = original_memory_replace
        storage_type.put = original_storage_put
        await close_lexical_clients()
        await dispose_engine()
        for root in tmp_roots:
            if root.name.startswith("gugu-rag-three-stage-ab-py-") and root.parent == Path(tempfile.gettempdir()):
                shutil.rmtree(root, ignore_errors=True)

try:
    asyncio.run(main())
except Exception as error:
    print(json.dumps({"error_type": type(error).__name__}))
    raise SystemExit(1)
`;

type Options = {
  allowRealData: boolean;
  ownerId?: string;
  rounds: number;
  order: "python-first" | "typescript-first";
  targetDocuments: number;
  baseline: { replaceMs: number; indexCacheGetMs: number; memoryLoadMs: number };
};

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith("--") && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      values.set(item, argv[index + 1]);
      index += 1;
    } else if (item.startsWith("--")) flags.add(item);
  }
  const rounds = Number(values.get("--rounds") ?? 3);
  const targetDocuments = Number(values.get("--target-documents") ?? 19_000);
  const orderValue = values.get("--order") ?? "typescript-first";
  if (orderValue !== "python-first" && orderValue !== "typescript-first") {
    throw new Error("invalid_order");
  }
  const number = (name: string, fallback: number) => Number(values.get(name) ?? fallback);
  return {
    allowRealData: flags.has("--allow-real-data"),
    ownerId: values.get("--owner-user-id"),
    rounds: Number.isInteger(rounds) && rounds >= 1 && rounds <= 5 ? rounds : 3,
    order: orderValue,
    targetDocuments: Number.isInteger(targetDocuments) && targetDocuments > 0 ? targetDocuments : 19_000,
    baseline: {
      replaceMs: number("--baseline-replace-ms", 7_150),
      indexCacheGetMs: number("--baseline-index-cache-get-ms", 8_920),
      memoryLoadMs: number("--baseline-memory-load-ms", 4_260),
    },
  };
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  if (!ordered.length) return 0;
  const middle = Math.floor(ordered.length / 2);
  return Number((ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2).toFixed(2));
}

function deltaPercent(candidate: number, baseline: number): number | null {
  if (!Number.isFinite(candidate) || !Number.isFinite(baseline) || baseline <= 0) return null;
  return Number((((candidate - baseline) / baseline) * 100).toFixed(1));
}

function memorySignatures(documents: RagDocument[]): Record<string, string> {
  const rows = documents.map((document) => {
    const key = [document.source_type, document.source_id || "", document.parent_id || document.id, document.chunk_index ?? 0];
    return [
      key,
      [document.document_version || "", document.chunk_count ?? 1],
      [document.title || "", document.summary || "", document.content || ""],
      [document.scope_type || "owner", document.scope_id || "", document.platform || "", document.bot_id || "", document.group_id || ""],
    ];
  });
  rows.sort((left, right) => {
    const leftKey = `${left[0][0]}|${left[0][2]}|${left[0][3]}`;
    const rightKey = `${right[0][0]}|${right[0][2]}|${right[0][3]}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const digest = (values: unknown[]) => createHash("sha256").update(JSON.stringify(values), "utf8").digest("hex");
  return {
    identity: digest(rows.map((row) => row[0])),
    version: digest(rows.map((row) => [row[0], row[1]])),
    text: digest(rows.map((row) => [row[0], row[2]])),
    scope: digest(rows.map((row) => [row[0], row[3]])),
  };
}

async function nextWorkerLine(
  child: ReturnType<typeof spawn>,
  lines: ReturnType<typeof createInterface>,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const response = new Promise<string>((resolveLine, reject) => {
    const onLine = (line: string) => { cleanup(); resolveLine(line); };
    const onError = () => { cleanup(); reject(new Error("worker_start_failed")); };
    const onClose = () => { cleanup(); reject(new Error("worker_closed_early")); };
    const cleanup = () => {
      lines.off("line", onLine);
      child.off("error", onError);
      child.off("close", onClose);
    };
    lines.once("line", onLine);
    child.once("error", onError);
    child.once("close", onClose);
  });
  const serialized = `${JSON.stringify(payload)}\n`;
  if (!child.stdin.write(serialized)) await once(child.stdin, "drain");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let raw: string;
  try {
    raw = await Promise.race([
      response,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("worker_timeout")), 60_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("worker_invalid_response");
  }
}

async function replaceInTemporaryWorker(
  documents: RagDocument[],
  revision: string,
): Promise<{ elapsedMs: number; indexedCount: number }> {
  const tempRoot = await mkdtemp(join(tmpdir(), "gugu-rag-three-stage-ab-ts-"));
  const indexDir = join(tempRoot, "index");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const started = performance.now();
    child = spawn(process.execPath, [workerArtifact, indexDir], {
      cwd: backendDir,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const response = await nextWorkerLine(child, lines, { op: "replace", revision, documents });
    if (response.status !== "ok") throw new Error(`worker_${String(response.code || "failed")}`);
    const elapsed = performance.now() - started;
    const closed = once(child, "close");
    child.stdin.end();
    await closed;
    lines.close();
    return { elapsedMs: elapsed, indexedCount: Number(response.document_count || 0) };
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    const normalizedRoot = resolve(tempRoot);
    if (normalizedRoot.startsWith(resolve(tmpdir()) + sep)
      && relative(tmpdir(), normalizedRoot).startsWith("gugu-rag-three-stage-ab-ts-")) {
      await rm(normalizedRoot, { recursive: true, force: true });
    }
  }
}

function asIso(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return text || undefined;
}

function toWorkerDocuments(rows: any[]): RagDocument[] {
  return rows.map((row) => {
    const sourceType = String(row.source_type || "");
    const parent = String(row.parent_document_id || row.document_id || "");
    const title = String(row.title || "");
    const summary = String(row.summary || "");
    const content = String(row.content || "");
    const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
    const contextText = sourceType === "conversation" && metadata.kind === "message"
      ? [metadata.context_before, metadata.context_current || content, metadata.context_after]
        .map((part: unknown) => String(part || ""))
        .filter((part: string) => part.trim())
        .join("\n").trim()
      : "";
    return {
      id: `${sourceType}:${parent}:${Number(row.chunk_index || 0)}`,
      text: [title, ...(summary ? [summary] : []), content].join("\n"),
      ...(sourceType === "conversation" ? { ranking_text: content } : {}),
      ...(contextText ? { context_text: contextText } : {}),
      content,
      source_type: sourceType,
      source_id: String(row.source_id || ""),
      title,
      summary,
      scope_type: String(row.scope_type || "owner"),
      scope_id: String(row.scope_id || ""),
      platform: String(row.platform || ""),
      bot_id: String(row.bot_id || ""),
      group_id: String(row.group_id || ""),
      document_version: String(row.document_version || ""),
      parent_id: parent,
      chunk_index: Number(row.chunk_index || 0),
      chunk_count: Number(row.chunk_count || 1),
      updated_at: asIso(row.source_updated_at),
      metadata,
    };
  });
}

async function loadIndexRows(sql: ReturnType<typeof createPostgresClient>, ownerId: string): Promise<any[]> {
  return await sql`
    SELECT source_type, source_id, scope_type, scope_id, platform, bot_id, group_id,
           document_id, parent_document_id, document_version, chunk_index, chunk_count,
           title, summary, content, metadata_json, source_updated_at
    FROM knowledge_index_entries
    WHERE owner_user_id = ${ownerId} AND deleted_at IS NULL
    ORDER BY id ASC
  `;
}

async function discoverOwner(
  sql: ReturnType<typeof createPostgresClient>,
  target: number,
): Promise<{ ownerId: string; count: number }> {
  const [row] = await sql`
    SELECT owner_user_id::text AS owner_id, count(*)::int AS document_count
    FROM knowledge_index_entries
    WHERE deleted_at IS NULL
    GROUP BY owner_user_id
    HAVING count(*) BETWEEN ${Math.floor(target * 0.8)} AND ${Math.ceil(target * 1.2)}
    ORDER BY abs(count(*) - ${target}), count(*) DESC
    LIMIT 1
  `;
  if (!row) throw new Error("no_owner_near_target_document_count");
  return { ownerId: String(row.owner_id), count: Number(row.document_count) };
}

async function indexRevision(sql: ReturnType<typeof createPostgresClient>, ownerId: string): Promise<string> {
  const rows = await sql`
    SELECT source_type, max(indexed_at) AS indexed_at
    FROM knowledge_index_entries
    WHERE owner_user_id = ${ownerId} AND deleted_at IS NULL
    GROUP BY source_type
    ORDER BY source_type
  `;
  return rows.map((row) => `${row.source_type}:${asIso(row.indexed_at) ?? ""}`).join(";");
}

async function duplicateWorkerKeys(sql: ReturnType<typeof createPostgresClient>, ownerId: string) {
  const [row] = await sql`
    SELECT count(*)::int AS duplicate_groups,
           coalesce(sum(duplicate_count - 1), 0)::int AS duplicate_extra_rows
    FROM (
      SELECT source_type, coalesce(nullif(parent_document_id, ''), document_id) AS parent_id,
             chunk_index, count(*)::int AS duplicate_count
      FROM knowledge_index_entries
      WHERE owner_user_id = ${ownerId} AND deleted_at IS NULL
      GROUP BY source_type, coalesce(nullif(parent_document_id, ''), document_id), chunk_index
      HAVING count(*) > 1
    ) AS duplicate_slots
  `;
  return {
    groups: Number(row?.duplicate_groups || 0),
    extraRows: Number(row?.duplicate_extra_rows || 0),
  };
}

function makeStorageReader(rootValue: string) {
  const root = resolve(rootValue);
  const allowedNames = new Set([
    "profile.json", "pattern.json", "summary.json", "daily.md", "memory.md", "memory-index-v1.json",
  ]);
  return {
    async readText({ ownerId, key, maxChars }: { ownerId: string; key: string; maxChars: number }) {
      const parts = key.split("/");
      const name = parts.at(-1) || "";
      const ownerFile = parts.length === 3 && parts[1] === ".agent" && allowedNames.has(name) && name !== "memory-index-v1.json";
      const indexFile = parts.length === 4 && parts[1] === ".agent" && parts[2] === "rag" && name === "memory-index-v1.json";
      if (parts[0] !== ownerId || (!ownerFile && !indexFile)) {
        throw new Error("storage_key_rejected");
      }
      const target = resolve(root, ...parts);
      const ownerRoot = resolve(root, ownerId);
      if (!target.startsWith(ownerRoot + sep) || !isAbsolute(target)) throw new Error("storage_path_rejected");
      try {
        const raw = await readFile(target, "utf8");
        return raw.length <= maxChars ? raw : Array.from(raw).slice(0, maxChars).join("");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error("storage_read_failed");
      }
    },
  };
}

function memorySourceRecord(sourceId: string, textValue: string, title: string, index: number, stableId?: unknown): RagSourceRecord | null {
  const content = textValue.trim();
  if (!content) return null;
  const sourceKey = String(stableId ?? `${sourceId}:${index}`);
  return {
    id: sourceKey,
    source_type: "memory",
    source_id: sourceId,
    parent_id: `memory:${sourceId}:${sourceKey}`,
    title,
    summary: Array.from(content).slice(0, 240).join(""),
    content,
    document_version: "",
    version_parts: [sourceId, sourceKey],
    scope: { scope_type: "owner", scope_id: "" },
    metadata: { vector_key: sourceId === "pattern" ? sourceKey : "" },
  };
}

function dailySourceRecords(dailyText: string): RagSourceRecord[] {
  const entries: Array<{ date: string; note: string }> = [];
  let currentDate = "";
  for (const raw of dailyText.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/u.exec(line);
    if (heading) {
      currentDate = heading[1];
      continue;
    }
    const bullet = /^-\s+(.+?)\s*$/u.exec(line);
    if (bullet && currentDate && bullet[1].trim()) entries.push({ date: currentDate, note: bullet[1].trim() });
  }
  return entries.map(({ date, note }, index) =>
    memorySourceRecord("daily", `- ${date} ${note}`, "近期记忆", index),
  ).filter((record): record is RagSourceRecord => record !== null);
}

function parseDailyRecords(dailyText: string): RagDocument[] {
  return buildSourceDocuments({ memory: dailySourceRecords(dailyText) });
}

function parseRawMemorySources(
  profileRaw: string | null,
  patternRaw: string | null,
  dailyText: string,
  memoryText: string | null,
): RagDocument[] {
  const records: RagSourceRecord[] = [];
  const parseList = (raw: string | null): unknown[] => {
    if (!raw?.trim()) return [];
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  };
  for (const [index, item] of parseList(profileRaw).entries()) {
    const text = typeof item === "string" ? item : item && typeof item === "object" ? String((item as any).text || "") : "";
    const record = memorySourceRecord("profile", text, "用户画像", index);
    if (record) records.push(record);
  }
  for (const [index, item] of parseList(patternRaw).entries()) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const record = memorySourceRecord("pattern", String(value.text || ""), "行为模式", index, value.id);
    if (record) records.push(record);
  }
  records.push(...dailySourceRecords(dailyText));

  const memory = (memoryText || "").trim();
  if (memory) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/gmu;
    const matches = [...memory.matchAll(heading)];
    const sections: Array<{ title: string; text: string }> = [];
    if (!matches.length) sections.push({ title: "", text: memory });
    else {
      const firstIndex = matches[0].index ?? 0;
      const prefix = memory.slice(0, firstIndex).trim();
      if (prefix) sections.push({ title: "", text: prefix });
      matches.forEach((match, index) => {
        const start = (match.index ?? 0) + match[0].length;
        const end = index + 1 < matches.length ? matches[index + 1].index ?? memory.length : memory.length;
        const body = memory.slice(start, end).trim();
        if (body) sections.push({ title: String(match[2]).trim(), text: body });
      });
    }
    sections.forEach((section, index) => {
      const text = section.title ? `${section.title}\n${section.text}` : section.text;
      const record = memorySourceRecord("memory", text, section.title || "长期记忆", index);
      if (record) records.push(record);
    });
  }
  return buildSourceDocuments({ memory: records });
}

function memoryIndexRecords(raw: string, ownerId: string): RagDocument[] {
  const parsed = JSON.parse(raw) as { schema_version?: number; documents?: unknown };
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.documents)) throw new Error("memory_index_invalid");
  const documents: RagDocument[] = [];
  for (const value of parsed.documents) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, any>;
    const sourceType = String(item.source_type || "");
    const parent = String(item.parent_document_id || item.document_id || "");
    const title = String(item.title || "");
    const summary = String(item.summary || "");
    const content = String(item.content || "");
    const scope = item.scope && typeof item.scope === "object" ? item.scope as Record<string, unknown> : {};
    const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
    if (!sourceType || !parent || String(scope.owner_user_id || "") !== ownerId) continue;
    documents.push({
      id: `${sourceType}:${parent}:${Number(item.chunk_index || 0)}`,
      text: [title, ...(summary ? [summary] : []), content].join("\n"),
      content,
      source_type: sourceType,
      source_id: String(item.source_id || ""),
      title,
      summary,
      scope_type: String(scope.scope_type || "owner"),
      scope_id: String(scope.scope_id || ""),
      platform: String(scope.platform || ""),
      bot_id: String(scope.bot_id || ""),
      group_id: String(scope.group_id || ""),
      document_version: String(item.version || ""),
      parent_id: parent,
      chunk_index: Number(item.chunk_index || 0),
      chunk_count: Number(item.chunk_count || 1),
      updated_at: asIso(item.updated_at),
      metadata,
    });
  }
  return documents;
}

async function loadCanonicalMemoryDocuments(
  storage: ReturnType<typeof makeStorageReader>,
  ownerId: string,
): Promise<{ documents: RagDocument[]; source: "persistent_index" | "source_rebuild" }> {
  const [indexRaw, dailyText] = await Promise.all([
    storage.readText({ ownerId, key: `${ownerId}/.agent/rag/memory-index-v1.json`, maxChars: 50_000_000 }),
    storage.readText({ ownerId, key: `${ownerId}/.agent/daily.md`, maxChars: 200_000 }),
  ]);
  if (indexRaw === null) {
    const [profileRaw, patternRaw, memoryText] = await Promise.all([
      storage.readText({ ownerId, key: `${ownerId}/.agent/profile.json`, maxChars: 200_000 }),
      storage.readText({ ownerId, key: `${ownerId}/.agent/pattern.json`, maxChars: 200_000 }),
      storage.readText({ ownerId, key: `${ownerId}/.agent/memory.md`, maxChars: 200_000 }),
    ]);
    return {
      documents: parseRawMemorySources(profileRaw, patternRaw, dailyText || "", memoryText),
      source: "source_rebuild",
    };
  }
  const cached = memoryIndexRecords(indexRaw, ownerId).filter((document) => document.source_id !== "daily");
  const freshDaily = parseDailyRecords(dailyText || "");
  return { documents: [...cached, ...freshDaily], source: "persistent_index" };
}

function runPythonBaseline(ownerId: string, rounds: number): Promise<Record<string, unknown>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(resolve(backendDir, ".venv/bin/python"), ["-c", PYTHON_BASELINE, ownerId, String(rounds)], {
      cwd: backendDir,
      env: { ...process.env, PYTHONPATH: backendDir },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output = (output + chunk).slice(-16_000); });
    child.once("error", () => reject(new Error("python_baseline_start_failed")));
    child.once("close", (code) => {
      const lastLine = output.trim().split(/\r?\n/u).at(-1) || "";
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(lastLine) as Record<string, unknown>; }
      catch { reject(new Error("python_baseline_invalid_output")); return; }
      if (code !== 0) {
        reject(new Error(`python_baseline_${String(parsed.error_type || "failed")}`));
        return;
      }
      resolveResult(parsed);
    });
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.allowRealData) throw new Error("refusing_real_data_without_allow_flag");
  if (!process.env.GUGU_DATABASE_URL?.trim()) throw new Error("missing_database_url_env");
  if (!process.env.GUGU_STORAGE_ROOT?.trim()) throw new Error("missing_storage_root_env");
  if (process.env.GUGU_STORAGE_BACKEND !== "local") throw new Error("memory_ts_ab_requires_local_storage_backend");
  if (!Number.isInteger(options.baseline.replaceMs) || !Number.isInteger(options.baseline.indexCacheGetMs)
    || !Number.isInteger(options.baseline.memoryLoadMs)) throw new Error("invalid_baseline_ms");

  const sql = createPostgresClient(process.env.GUGU_DATABASE_URL, { max: 2, connectTimeout: 10 });
  try {
    const selected = options.ownerId
      ? { ownerId: options.ownerId, count: 0 }
      : await discoverOwner(sql, options.targetDocuments);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(selected.ownerId)) {
      throw new Error("invalid_owner_uuid");
    }
    const ownerCount = selected.count || Number((await sql`
      SELECT count(*)::int AS document_count FROM knowledge_index_entries
      WHERE owner_user_id = ${selected.ownerId} AND deleted_at IS NULL
    `)[0]?.document_count || 0);
    const docs = toWorkerDocuments(await loadIndexRows(sql, selected.ownerId));
    if (docs.length !== ownerCount) throw new Error("index_count_changed_during_benchmark");
    const duplicateKeys = await duplicateWorkerKeys(sql, selected.ownerId);

    // 通过 --order 交替两组执行先后，减少固定顺序造成的缓存/负载偏差。
    let python: Record<string, unknown> | undefined;
    if (options.order === "python-first") {
      python = await runPythonBaseline(selected.ownerId, options.rounds);
    }

    const tsReplace: number[] = [];
    let tsReplaceIndexedCount = 0;
    for (let index = 0; index < options.rounds; index += 1) {
      const result = await replaceInTemporaryWorker(docs, `rag-ab-replace-${index}`);
      tsReplace.push(result.elapsedMs);
      tsReplaceIndexedCount = result.indexedCount;
    }

    const tsIndexCacheGet: number[] = [];
    let tsIndexCount = 0;
    for (let index = 0; index < options.rounds; index += 1) {
      const started = performance.now();
      const revision = await indexRevision(sql, selected.ownerId);
      const rows = await loadIndexRows(sql, selected.ownerId);
      const documents = toWorkerDocuments(rows);
      if (documents.length !== ownerCount) throw new Error("index_count_changed_during_benchmark");
      const replaced = await replaceInTemporaryWorker(documents, `rag-ab-get-${index}-${revision.slice(0, 24)}`);
      tsIndexCount = replaced.indexedCount;
      tsIndexCacheGet.push(performance.now() - started);
    }

    const runtime = new DataRuntime(sql);
    const storage = makeStorageReader(process.env.GUGU_STORAGE_ROOT);
    const tsMemoryCold: number[] = [];
    let tsMemoryCount = 0;
    let finalRevision = "";
    for (let index = 0; index < options.rounds; index += 1) {
      finalRevision = `rag-memory-ab-${index}-${performance.now()}`;
      const started = performance.now();
      const result = await loadMemoryCached(runtime, { ownerId: selected.ownerId }, storage, finalRevision);
      tsMemoryCold.push(performance.now() - started);
      tsMemoryCount = result.records.length;
    }
    const warmStarted = performance.now();
    const memoryWarm = await loadMemoryCached(runtime, { ownerId: selected.ownerId }, storage, finalRevision);
    const tsMemoryWarmMs = performance.now() - warmStarted;

    const canonicalMemoryCold: number[] = [];
    let canonicalMemoryCount = 0;
    let canonicalMemorySource: "persistent_index" | "source_rebuild" = "source_rebuild";
    let canonicalMemoryDocuments: RagDocument[] = [];
    const canonicalCacheKey = `owner:${selected.ownerId}|scope:owner:${selected.ownerId}|source:memory|page:full`;
    let canonicalRevision = "";
    for (let index = 0; index < options.rounds; index += 1) {
      canonicalRevision = `rag-memory-canonical-ab-${index}-${performance.now()}`;
      const started = performance.now();
      const result = await runtime.readCachedWithStatus(canonicalCacheKey, canonicalRevision, async () => {
        const loaded = await loadCanonicalMemoryDocuments(storage, selected.ownerId);
        canonicalMemorySource = loaded.source;
        canonicalMemoryDocuments = loaded.documents;
        return { records: loaded.documents };
      });
      canonicalMemoryCold.push(performance.now() - started);
      canonicalMemoryCount = result.value.records.length;
    }
    const canonicalWarmStarted = performance.now();
    const canonicalMemoryWarm = await runtime.readCachedWithStatus(canonicalCacheKey, canonicalRevision, async () => {
      const loaded = await loadCanonicalMemoryDocuments(storage, selected.ownerId);
      canonicalMemorySource = loaded.source;
      canonicalMemoryDocuments = loaded.documents;
      return { records: loaded.documents };
    });
    const canonicalMemoryWarmMs = performance.now() - canonicalWarmStarted;

    // Memory 持久化写入被禁用；默认沿用 TS-first，反序复测可用 --order python-first。
    if (!python) python = await runPythonBaseline(selected.ownerId, options.rounds);
    const pythonMemoryCount = Number(python.memory_document_count || 0);
    const tsMemorySignatures = memorySignatures(canonicalMemoryDocuments);
    const pythonMemorySignatures = python.memory_signatures as Record<string, string>;
    const memorySignatureMatches = Object.fromEntries(
      ["identity", "version", "text", "scope"].map((key) => [key, tsMemorySignatures[key] === pythonMemorySignatures?.[key]]),
    );
    const canonicalMemorySignatureMatches = Object.values(memorySignatureMatches).every(Boolean);
    const canonicalMemoryMatches = canonicalMemoryCount === pythonMemoryCount && canonicalMemorySignatureMatches;
    await runtime.close();

    const report = {
      dataset: {
        active_index_chunks: docs.length,
        duplicate_worker_key_groups: duplicateKeys.groups,
        duplicate_worker_key_extra_rows: duplicateKeys.extraRows,
        selected_by: options.ownerId ? "explicit_owner" : "count_near_target",
      },
      iterations: options.rounds,
      execution_order: options.order,
      python_current: {
        full_replace_worker_ms_median: python.replace_ms,
        index_cache_get_ms_median: python.index_cache_get_ms,
        memory_source_load_ms: python.memory_load_ms,
        index_chunks: python.index_document_count,
        memory_chunks: python.memory_document_count,
        memory_storage_writes: "disabled",
      },
      typescript_candidate: {
        full_replace_ms_median: median(tsReplace),
        index_cache_get_cold_ms_median: median(tsIndexCacheGet),
        memory_raw_file_load_cold_ms_median: median(tsMemoryCold),
        memory_raw_file_load_warm_ms: Number(tsMemoryWarmMs.toFixed(2)),
        memory_canonical_load_cold_ms_median: median(canonicalMemoryCold),
        memory_canonical_load_warm_ms: Number(canonicalMemoryWarmMs.toFixed(2)),
        index_chunks: tsIndexCount,
        memory_records: tsMemoryCount,
        memory_canonical_chunks: canonicalMemoryCount,
        memory_canonical_source: canonicalMemorySource,
        memory_canonical_count_matches_python: canonicalMemoryCount === pythonMemoryCount,
        memory_canonical_signature_matches_python: memorySignatureMatches,
        full_replace_effective_indexed_chunks: tsReplaceIndexedCount,
      },
      ab_delta_percent_vs_python_current: {
        full_replace_worker: deltaPercent(median(tsReplace), Number(python.replace_ms)),
        index_cache_get_cold: deltaPercent(median(tsIndexCacheGet), Number(python.index_cache_get_ms)),
        memory_load: canonicalMemoryMatches
          ? deltaPercent(median(canonicalMemoryCold), Number(python.memory_load_ms))
          : null,
      },
      supplied_baseline_ms: options.baseline,
      comparison_note: "TS index_cache_get 包含 revision 查询、正文行读取/映射与临时 worker replace，但不含持久向量表加载；memory_raw_file_load 仅测五文件读取，不与 Python 比；memory_canonical_load 复现持久 Memory 索引读取、daily 新鲜度与 TS chunk 投影，只有 chunk 数及 canonical 签名与 Python 一致才计算 A/B 差值。所有 worker 索引写入隔离在临时目录，Python 存储写入被拦截。",
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  const errorType = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`benchmark_failed:${errorType}\n`);
  process.exitCode = 1;
});
